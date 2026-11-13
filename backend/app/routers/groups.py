from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app.codeword import codeword_key
from app.config import get_settings
from app.draw import check_can_draw, check_draw_rate, notify_draw, run_draw
from app.email import EmailSender, get_email_sender, send_safely, templates
from app.models import Group, LinkToken, Participant
from app.ratelimit import client_ip, limiter
from app.schemas import (
    AddParticipant,
    AdminGroup,
    GroupCreate,
    GroupCreated,
    GroupPublic,
    GroupUpdate,
    ParticipantSummary,
)
from app.security import DB, NOT_FOUND, Member, hash_token, new_token
from app.security import AdminGroup as AdminGroupDep
from app.services import (
    MAX_PARTICIPANTS,
    admin_link,
    codeword_taken,
    exclusion_pair_count,
    group_public,
    invite_link,
    name_taken,
    participant_link,
    participant_status,
    participant_summaries,
)
from app.unsubscribe import links as unsubscribe_links

router = APIRouter()

Sender = Annotated[EmailSender, Depends(get_email_sender)]

CODEWORD_TAKEN = HTTPException(status.HTTP_409_CONFLICT, "That codeword is taken. Try another.")


def _check_group_rate(db: DB, request: Request) -> None:
    limiter.check(db, "group_create", client_ip(request), get_settings().rate_limit_group_create)


def check_email_rate(db: DB, request: Request, email: str) -> None:
    limit = get_settings().rate_limit_email_send
    limiter.check(db, "email_ip", client_ip(request), limit)
    limiter.check(db, "email_to", email, limit)


@router.post("/groups", status_code=status.HTTP_201_CREATED, response_model=GroupCreated)
def create_group(body: GroupCreate, request: Request, db: DB, sender: Sender) -> GroupCreated:
    _check_group_rate(db, request)
    check_email_rate(db, request, body.admin_email)
    key = codeword_key(body.codeword)
    if codeword_taken(db, key):
        raise CODEWORD_TAKEN

    admin_token = new_token()
    group = Group(
        name=body.name,
        gift_date=body.gift_date,
        budget_min=body.budget_min,
        budget_max=body.budget_max,
        message=body.message or None,
        admin_name=body.admin_name,
        admin_email=body.admin_email,
        admin_token_hash=hash_token(admin_token),
        invite_token=new_token(),
        codeword=body.codeword,
        codeword_key=key,
    )
    if body.admin_participates:
        # The organiser uses their admin link for their own wish list too. Their
        # participant row still needs a token hash, so give it one nobody holds.
        group.participants.append(
            Participant(
                name=body.admin_name,
                email=body.admin_email,
                token_hash=hash_token(new_token()),
                is_admin=True,
                joined_at=datetime.now(UTC),
            )
        )
    db.add(group)
    try:
        db.commit()
    except IntegrityError as exc:  # someone took the codeword a moment ago
        db.rollback()
        raise CODEWORD_TAKEN from exc

    links = GroupCreated(
        group_id=group.id,
        admin_link=admin_link(admin_token),
        invite_link=invite_link(group),
    )
    send_safely(
        sender,
        templates.admin_created(
            group, links.admin_link, body.admin_participates, unsubscribe_links("a", group.id)
        ),
    )
    return links


@router.get("/admin/group", response_model=AdminGroup)
def get_admin_group(group: AdminGroupDep, db: DB) -> AdminGroup:
    return AdminGroup(
        **group_public(group).model_dump(),
        codeword=group.codeword,
        invite_link=invite_link(group),
        drawn_at=group.drawn_at,
        show_exclusions=group.show_exclusions,
        exclusion_pair_count=exclusion_pair_count(db, group),
        participants=participant_summaries(group),
    )


def _member_of(member, group_id: int) -> Group:  # type: ignore[no-untyped-def]
    if member.group.id != group_id:
        raise NOT_FOUND
    return member.group


@router.get("/groups/{group_id}", response_model=GroupPublic)
def get_group(group_id: int, member: Member) -> GroupPublic:
    return group_public(_member_of(member, group_id))


@router.patch("/groups/{group_id}", response_model=GroupPublic)
def update_group(group_id: int, body: GroupUpdate, member: Member, db: DB) -> GroupPublic:
    group = _member_of(member, group_id)
    if not member.is_admin:
        raise NOT_FOUND
    changes = body.model_dump(exclude_unset=True)
    for field in ("name", "gift_date", "budget_min", "budget_max", "show_exclusions"):
        if changes.get(field) is None:
            changes.pop(field, None)
    budget_min = changes.get("budget_min", group.budget_min)
    budget_max = changes.get("budget_max", group.budget_max)
    if budget_max < budget_min:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Max budget must be at least the min budget",
        )
    if "message" in changes:
        changes["message"] = changes["message"] or None
    if changes.get("codeword") is not None:
        key = codeword_key(changes["codeword"])
        if codeword_taken(db, key, group.id):
            raise CODEWORD_TAKEN
        changes["codeword_key"] = key
    else:
        changes.pop("codeword", None)
    for field, value in changes.items():
        setattr(group, field, value)
    db.commit()
    return group_public(group)


@router.post(
    "/groups/{group_id}/participants",
    status_code=status.HTTP_201_CREATED,
    response_model=ParticipantSummary,
)
def add_participant(
    group_id: int,
    body: AddParticipant,
    request: Request,
    group: AdminGroupDep,
    db: DB,
    sender: Sender,
) -> ParticipantSummary:
    if group.id != group_id:
        raise NOT_FOUND
    drawn = group.draw_status == "drawn"
    if drawn:
        check_can_draw(group, body.confirm_redraw)
    count = db.scalar(select(func.count()).where(Participant.group_id == group.id))
    if count >= MAX_PARTICIPANTS:
        raise HTTPException(status.HTTP_409_CONFLICT, "This group is full")
    if name_taken(db, group, body.name):
        raise HTTPException(status.HTTP_409_CONFLICT, f"{body.name} is already in")
    if body.email is not None:
        check_email_rate(db, request, body.email)
        if db.scalar(
            select(Participant.id).where(
                Participant.group_id == group.id, Participant.email == body.email
            )
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "Someone with that email is already in")
    if drawn:
        check_draw_rate(db, group)

    token = new_token()
    participant = Participant(
        group_id=group.id, name=body.name, email=body.email, token_hash=hash_token(token)
    )
    db.add(participant)
    try:
        if drawn:
            run_draw(db, group)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Someone with that email is already in"
        ) from exc
    except Exception:
        db.rollback()
        raise
    if body.email is not None:
        send_safely(
            sender,
            templates.invited_by_admin(
                group,
                body.name,
                body.email,
                participant_link(token),
                unsubscribe_links("p", participant.id),
            ),
        )
    if drawn:
        notify_draw(sender, group, redraw=True, skip={participant.id})
    return ParticipantSummary(
        id=participant.id,
        name=participant.name,
        status=participant_status(participant),
        is_admin=False,
    )


@router.post("/groups/{group_id}/regenerate-admin-link", status_code=status.HTTP_204_NO_CONTENT)
def regenerate_admin_link(
    group_id: int,
    request: Request,
    group: AdminGroupDep,
    db: DB,
    sender: Sender,
) -> None:
    if group.id != group_id:
        raise NOT_FOUND
    check_email_rate(db, request, group.admin_email)
    token = new_token()
    group.admin_token_hash = hash_token(token)
    # A leaked link may have been opened elsewhere: drop every extra admin link too.
    db.execute(
        delete(LinkToken).where(LinkToken.group_id == group.id, LinkToken.participant_id.is_(None))
    )
    db.commit()
    send_safely(
        sender,
        templates.admin_link_regenerated(
            group, admin_link(token), unsubscribe_links("a", group.id)
        ),
    )

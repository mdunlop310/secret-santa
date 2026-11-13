from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import func, select

from app.email import send_safely, templates
from app.models import Group, Participant
from app.routers.groups import Sender, check_email_rate
from app.schemas import InvitePreview, JoinRequest, JoinResult
from app.security import DB, NOT_FOUND, hash_token, new_token
from app.services import MAX_PARTICIPANTS, member_open_link, name_taken, participant_link
from app.unsubscribe import links as unsubscribe_links

router = APIRouter()


def _group_for_invite(db: DB, invite_token: str) -> Group:
    if len(invite_token) > 128:
        raise NOT_FOUND
    group = db.scalar(select(Group).where(Group.invite_token == invite_token))
    if group is None:
        raise NOT_FOUND
    return group


@router.get("/join/{invite_token}", response_model=InvitePreview)
def invite_preview(invite_token: str, db: DB) -> InvitePreview:
    group = _group_for_invite(db, invite_token)
    return InvitePreview(
        group_name=group.name,
        admin_name=group.admin_name,
        gift_date=group.gift_date,
        budget_min=group.budget_min,
        budget_max=group.budget_max,
        message=group.message,
    )


@router.post("/join/{invite_token}", status_code=status.HTTP_201_CREATED)
def join(
    invite_token: str,
    body: JoinRequest,
    request: Request,
    response: Response,
    db: DB,
    sender: Sender,
) -> JoinResult:
    """Join a group and go straight to your wish list; the email is a copy for later.

    If the email is already in the group, nobody is let in: a link is emailed instead
    (202), so knowing someone's email and the invite link isn't enough to act as them.
    """
    group = _group_for_invite(db, invite_token)
    existing = None
    if body.email is not None:
        check_email_rate(db, request, body.email)
        existing = db.scalar(
            select(Participant).where(
                Participant.group_id == group.id, Participant.email == body.email
            )
        )
    if existing is not None:
        if existing.joined_at is None:
            existing.joined_at = datetime.now(UTC)
            db.commit()
        send_safely(
            sender,
            templates.personal_link(
                group,
                existing.name,
                body.email,
                member_open_link(existing),
                unsubscribe_links("p", existing.id),
            ),
        )
        response.status_code = status.HTTP_202_ACCEPTED
        return JoinResult(status="sent")

    if group.draw_status == "drawn":
        raise HTTPException(status.HTTP_409_CONFLICT, "The draw has already happened")
    count = db.scalar(select(func.count()).where(Participant.group_id == group.id))
    if count >= MAX_PARTICIPANTS:
        raise HTTPException(status.HTTP_409_CONFLICT, "This group is full")
    if name_taken(db, group, body.name):
        raise HTTPException(status.HTTP_409_CONFLICT, f"{body.name} is already in")
    token = new_token()
    participant = Participant(
        group_id=group.id,
        name=body.name,
        email=body.email,
        token_hash=hash_token(token),
        joined_at=datetime.now(UTC),
    )
    db.add(participant)
    db.commit()
    link = participant_link(token)
    if body.email is not None:
        send_safely(
            sender,
            templates.personal_link(
                group, body.name, body.email, link, unsubscribe_links("p", participant.id)
            ),
        )
    return JoinResult(status="joined", participant_link=link)

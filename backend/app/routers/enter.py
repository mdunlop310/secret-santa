"""Getting in with the group's codeword: pick your name, or join if you're new.

Anyone holding the codeword can pick any name, by design: the organiser chose a
trust-based group. Nothing here returns who has whom; picking a name gives the same
access as that person's own link, which only ever shows their own giftee.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import func, select

from app.codeword import codeword_key
from app.config import get_settings
from app.email import send_safely, templates
from app.models import Group, Participant
from app.ratelimit import client_ip, limiter
from app.routers.groups import Sender, check_email_rate
from app.schemas import (
    CodewordJoinRequest,
    EnteredGroup,
    EnteredLink,
    EnterRequest,
    PersonRef,
    PickRequest,
)
from app.security import DB, hash_token, issue_link, new_token
from app.services import MAX_PARTICIPANTS, member_open_link, name_taken, participant_link
from app.unsubscribe import links as unsubscribe_links

router = APIRouter()

WRONG_CODEWORD = HTTPException(status.HTTP_404_NOT_FOUND, "No group has that codeword")


def _group_for(db: DB, request: Request, codeword: str) -> Group:
    # Every attempt counts, so codewords can't be guessed quickly.
    limiter.check(db, "codeword", client_ip(request), get_settings().rate_limit_codeword)
    key = codeword_key(codeword)
    group = db.scalar(select(Group).where(Group.codeword_key == key)) if key else None
    if group is None:
        raise WRONG_CODEWORD
    return group


@router.post("/enter", response_model=EnteredGroup)
def enter(body: EnterRequest, request: Request, db: DB) -> EnteredGroup:
    group = _group_for(db, request, body.codeword)
    return EnteredGroup(
        group_name=group.name,
        admin_name=group.admin_name,
        gift_date=group.gift_date,
        budget_min=group.budget_min,
        budget_max=group.budget_max,
        message=group.message,
        draw_status=group.draw_status,
        people=[PersonRef(id=p.id, name=p.name) for p in group.participants],
    )


@router.post("/enter/pick", response_model=EnteredLink)
def pick(body: PickRequest, request: Request, db: DB) -> EnteredLink:
    group = _group_for(db, request, body.codeword)
    participant = next((p for p in group.participants if p.id == body.participant_id), None)
    if participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That person isn't in this group")
    participant.joined_at = participant.joined_at or datetime.now(UTC)
    link = participant_link(issue_link(db, group, participant))
    db.commit()
    return EnteredLink(link=link)


@router.post("/enter/join", status_code=status.HTTP_201_CREATED, response_model=EnteredLink)
def join(body: CodewordJoinRequest, request: Request, db: DB, sender: Sender) -> EnteredLink:
    group = _group_for(db, request, body.codeword)
    if group.draw_status == "drawn":
        raise HTTPException(status.HTTP_409_CONFLICT, "The draw has already happened")
    count = db.scalar(select(func.count()).where(Participant.group_id == group.id))
    if count >= MAX_PARTICIPANTS:
        raise HTTPException(status.HTTP_409_CONFLICT, "This group is full")
    if name_taken(db, group, body.name):
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"{body.name} is already in. Pick your name from the list."
        )
    if body.email is not None:
        check_email_rate(db, request, body.email)
        if db.scalar(
            select(Participant.id).where(
                Participant.group_id == group.id, Participant.email == body.email
            )
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Someone with that email is already in. Pick your name from the list.",
            )
    participant = Participant(
        group_id=group.id,
        name=body.name,
        email=body.email,
        token_hash=hash_token(new_token()),
        joined_at=datetime.now(UTC),
    )
    db.add(participant)
    db.flush()
    link = participant_link(issue_link(db, group, participant))
    db.commit()
    if participant.email:
        send_safely(
            sender,
            templates.personal_link(
                group,
                participant.name,
                participant.email,
                member_open_link(participant),
                unsubscribe_links("p", participant.id),
            ),
        )
    return EnteredLink(link=link)

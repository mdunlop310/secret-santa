"""Running and storing the draw. Assignments are written here and read only by /me/giftee."""

from datetime import UTC, date, datetime

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import matching
from app.config import get_settings
from app.email import EmailSender, send_many_safely, templates
from app.models import Assignment, Exclusion, Group
from app.ratelimit import limiter
from app.services import member_open_link
from app.unsubscribe import links as unsubscribe_links


def conflict(code: str, message: str, **extra: object) -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT, detail={"code": code, "message": message, **extra}
    )


def check_can_draw(group: Group, confirm_redraw: bool) -> None:
    """Raise unless a (re)draw is allowed now. Redraws are allowed until the gift date."""
    if group.gift_date < date.today():
        raise conflict("gift_date_passed", "The gift exchange date has passed")
    if group.draw_status == "drawn" and not confirm_redraw:
        raise conflict(
            "confirm_redraw", "This needs a redraw. Everyone will get a new giftee and an email."
        )


def run_draw(db: Session, group: Group) -> None:
    """Draw and store one round, replacing any earlier one. Raises a 409 if impossible.

    Superseded rounds are deleted rather than kept: nothing needs them, and an old round
    is still a list of who had whom.
    """
    db.flush()
    db.refresh(group, ["participants"])
    people = [p.id for p in group.participants]
    blocked = set(
        db.execute(
            select(Exclusion.giver_id, Exclusion.giftee_id).where(Exclusion.group_id == group.id)
        ).tuples()
    )
    try:
        result = matching.draw(people, blocked)
    except matching.NoValidDraw as exc:
        if exc.bottleneck is None:
            raise conflict("too_few", "A draw needs at least 3 people") from None
        b = exc.bottleneck
        raise conflict(
            "no_valid_draw",
            "No valid draw with these exclusions",
            bottleneck={"side": b.side, "people": list(b.people), "options": list(b.options)},
        ) from None

    last_round = db.scalar(
        select(func.max(Assignment.draw_round)).where(Assignment.group_id == group.id)
    )
    db.execute(delete(Assignment).where(Assignment.group_id == group.id))
    draw_round = (last_round or 0) + 1
    db.add_all(
        Assignment(group_id=group.id, giver_id=g, giftee_id=t, draw_round=draw_round)
        for g, t in result.items()
    )
    group.draw_status = "drawn"
    group.drawn_at = datetime.now(UTC)


def check_draw_rate(db: Session, group: Group) -> None:
    """Each draw emails everyone, so cap how often an admin can trigger one."""
    if not limiter.hit(db, "draw", str(group.id), get_settings().rate_limit_draw):
        raise conflict("too_many_draws", "Too many draws in a short time. Try again later.")


def notify_draw(
    sender: EmailSender,
    group: Group,
    redraw: bool,
    skip: frozenset[int] | set[int] = frozenset(),
) -> None:
    """Email everyone that names were drawn. Sent before the response returns: on
    serverless hosts nothing is guaranteed to run after it."""
    messages = [
        templates.draw_done(
            group,
            p.name,
            p.email,
            member_open_link(p, "giftee"),
            redraw,
            unsubscribe_links("p", p.id),
        )
        for p in group.participants
        if p.id not in skip and p.email
    ]
    send_many_safely(sender, messages)

"""Scheduled work: reminders, wish-list-changed emails and deleting old groups.

Safe to run as often as you like (every 15 minutes is the plan): each daily reminder is
recorded in `reminders` and never sent twice, and daily reminders wait until DAILY_HOUR.
Run with `python -m app.jobs` or POST /internal/jobs/run.
"""

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.email import EmailSender, send_safely, templates
from app.models import Assignment, Group, Participant, Reminder, WishlistItem
from app.ratelimit import limiter
from app.services import admin_open_link, member_open_link
from app.unsubscribe import links as unsubscribe_links

DAILY_HOUR = 9  # UTC; daily reminders go out on the first run at or after this hour
DELETE_AFTER_DAYS = 30
INVITE_REMINDER_AFTER = timedelta(days=3)
INVITE_REMINDER_MAX = 2
NUDGE_AFTER = timedelta(days=3)
NUDGE_EVERY = timedelta(days=7)
GIFT_DATE_REMINDER_DAYS = (7, 1)
DRAW_PENDING_DAYS = (7, 3, 1)
WISHLIST_CHANGED_DELAY = timedelta(minutes=15)
WISHLIST_CHANGED_GAP = timedelta(hours=1)


@dataclass
class Report:
    deleted_groups: int = 0
    sent: dict[str, int] = field(default_factory=dict)

    def count(self, kind: str) -> None:
        self.sent[kind] = self.sent.get(kind, 0) + 1


def _record(
    db: Session, group: Group, participant: Participant | None, kind: str, now: datetime
) -> None:
    db.add(
        Reminder(
            group_id=group.id,
            participant_id=participant.id if participant else None,
            type=kind,
            send_at=now,
            sent_at=now,
        )
    )


def _last_sent(
    db: Session, group: Group, participant: Participant | None, kind: str
) -> tuple[datetime | None, int]:
    """When this reminder last went out to this person, and how many times in all."""
    who = (
        Reminder.participant_id == participant.id
        if participant
        else Reminder.participant_id.is_(None)
    )
    last, count = db.execute(
        select(func.max(Reminder.sent_at), func.count(Reminder.sent_at)).where(
            Reminder.group_id == group.id, Reminder.type == kind, who
        )
    ).one()
    return last, count


def schedule_wishlist_changed(db: Session, owner: Participant, now: datetime) -> None:
    """Called when a wish list changes after the draw.

    Coalesces bursts: at most one pending email per list, sent after a short delay and
    at least an hour after the previous email about the same list.
    """
    group = owner.group
    if group.draw_status != "drawn":
        return
    pending = db.scalar(
        select(Reminder.id).where(
            Reminder.participant_id == owner.id,
            Reminder.type == "wishlist_changed",
            Reminder.sent_at.is_(None),
        )
    )
    if pending:
        return
    last, _ = _last_sent(db, group, owner, "wishlist_changed")
    send_at = now + WISHLIST_CHANGED_DELAY
    if last is not None:
        send_at = max(send_at, last + WISHLIST_CHANGED_GAP)
    db.add(
        Reminder(
            group_id=group.id, participant_id=owner.id, type="wishlist_changed", send_at=send_at
        )
    )


def delete_expired_groups(db: Session, today: date) -> int:
    """Delete groups (and, by cascade, all their personal data) 30 days after the gift date."""
    cutoff = today - timedelta(days=DELETE_AFTER_DAYS)
    result = db.execute(delete(Group).where(Group.gift_date < cutoff))
    return result.rowcount or 0


def send_wishlist_changes(db: Session, sender: EmailSender, now: datetime, report: Report) -> None:
    due = db.scalars(
        select(Reminder).where(
            Reminder.type == "wishlist_changed",
            Reminder.sent_at.is_(None),
            Reminder.send_at <= now,
        )
    ).all()
    for reminder in due:
        reminder.sent_at = now
        group = db.get(Group, reminder.group_id)
        # Find the giver now rather than when the list changed: a redraw may have moved them.
        giver = db.scalar(
            select(Participant)
            .join(Assignment, Assignment.giver_id == Participant.id)
            .where(
                Assignment.group_id == reminder.group_id,
                Assignment.giftee_id == reminder.participant_id,
            )
        )
        if group is None or giver is None or not giver.email or giver.unsubscribed_at is not None:
            continue
        message = templates.wishlist_changed(
            group,
            giver.name,
            giver.email,
            member_open_link(giver, "giftee"),
            unsubscribe_links("p", giver.id),
        )
        send_safely(sender, message)
        report.count("wishlist_changed")


def send_daily(db: Session, sender: EmailSender, now: datetime, report: Report) -> None:
    today = now.date()
    for group in db.scalars(select(Group).where(Group.gift_date >= today)).all():
        days_left = (group.gift_date - today).days

        if (
            group.draw_status != "drawn"
            and days_left in DRAW_PENDING_DAYS
            and group.admin_unsubscribed_at is None
        ):
            kind = f"draw_pending_{days_left}"
            if _last_sent(db, group, None, kind)[1] == 0:
                message = templates.draw_pending(
                    group, days_left, admin_open_link(group), unsubscribe_links("a", group.id)
                )
                send_safely(sender, message)
                _record(db, group, None, kind, now)
                report.count("draw_pending")

        for p in group.participants:
            if not p.email or p.unsubscribed_at is not None:
                continue
            unsub = unsubscribe_links("p", p.id)

            if p.joined_at is None:
                last, sent = _last_sent(db, group, p, "invite")
                since = last or p.created_at
                if sent < INVITE_REMINDER_MAX and now - since >= INVITE_REMINDER_AFTER:
                    message = templates.invite_reminder(
                        group, p.name, p.email, member_open_link(p), unsub
                    )
                    send_safely(sender, message)
                    _record(db, group, p, "invite", now)
                    report.count("invite")
                continue

            has_items = db.scalar(select(func.count()).where(WishlistItem.participant_id == p.id))
            if not has_items and not p.secret_surprise:
                last, _ = _last_sent(db, group, p, "wishlist_nudge")
                due = (
                    now - p.joined_at >= NUDGE_AFTER if last is None else now - last >= NUDGE_EVERY
                )
                if due:
                    message = templates.wishlist_nudge(
                        group, p.name, p.email, member_open_link(p), unsub
                    )
                    send_safely(sender, message)
                    _record(db, group, p, "wishlist_nudge", now)
                    report.count("wishlist_nudge")

            if group.draw_status == "drawn" and days_left in GIFT_DATE_REMINDER_DAYS:
                kind = f"gift_date_{days_left}"
                if _last_sent(db, group, p, kind)[1] == 0:
                    message = templates.gift_date_soon(
                        group, p.name, p.email, days_left, member_open_link(p, "giftee"), unsub
                    )
                    send_safely(sender, message)
                    _record(db, group, p, kind, now)
                    report.count("gift_date")


def run(db: Session, sender: EmailSender, now: datetime | None = None) -> Report:
    now = now or datetime.now(UTC)
    report = Report()
    report.deleted_groups = delete_expired_groups(db, now.date())
    limiter.delete_old(db, now)
    db.commit()
    send_wishlist_changes(db, sender, now, report)
    db.commit()
    if now.hour >= DAILY_HOUR:
        send_daily(db, sender, now, report)
        db.commit()
    return report


def main() -> None:
    from app.db import get_sessionmaker
    from app.email import get_email_sender

    with get_sessionmaker()() as db:
        report = run(db, get_email_sender())
    print(f"deleted_groups={report.deleted_groups} sent={report.sent}")


if __name__ == "__main__":
    main()

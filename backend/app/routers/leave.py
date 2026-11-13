"""Removing yourself and your data, as a participant or as the admin."""

from datetime import date

from fastapi import APIRouter, HTTPException
from sqlalchemy import delete

from app.draw import notify_draw, run_draw
from app.email import send_safely, templates
from app.models import Assignment
from app.routers.groups import Sender
from app.security import DB, AdminGroup, OwnParticipant
from app.services import admin_open_link
from app.unsubscribe import links as unsubscribe_links

router = APIRouter()


@router.delete("/me", status_code=204)
def leave(participant: OwnParticipant, db: DB, sender: Sender) -> None:
    """Delete yourself, your wish list and your exclusions.

    Leaving can't be blocked by the draw. Before the gift date we redraw for everyone
    else; if that's impossible the draw is cleared and the admin is told.
    """
    if participant.is_admin:
        # Picking the organiser's name with the codeword gives a participant link to
        # their record, but only the organiser's own link can remove them (by deleting
        # the group).
        raise HTTPException(409, "The organiser can't leave. Delete the group instead.")
    group = participant.group
    name = participant.name
    drawn = group.draw_status == "drawn"
    db.delete(participant)

    redrawn = None
    if drawn and group.gift_date >= date.today():
        try:
            run_draw(db, group)
            redrawn = True
        except HTTPException:
            db.execute(delete(Assignment).where(Assignment.group_id == group.id))
            group.draw_status = "not_drawn"
            group.drawn_at = None
            redrawn = False
    db.commit()

    if redrawn is True:
        notify_draw(sender, group, redraw=True)
    if redrawn is not None:
        send_safely(
            sender,
            templates.participant_left(
                group, name, redrawn, admin_open_link(group), unsubscribe_links("a", group.id)
            ),
        )


@router.delete("/admin/group", status_code=204)
def delete_group(group: AdminGroup, db: DB) -> None:
    """Delete the whole group and everyone's data in it. Can't be undone."""
    db.delete(group)
    db.commit()

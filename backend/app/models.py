from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

DRAW_STATUSES = ("not_drawn", "drawn")


class Group(Base):
    __tablename__ = "groups"
    __table_args__ = (
        CheckConstraint("budget_min >= 0", name="budget_min_non_negative"),
        CheckConstraint("budget_max >= budget_min", name="budget_max_gte_min"),
        CheckConstraint("draw_status IN ('not_drawn', 'drawn')", name="draw_status_valid"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    budget_min: Mapped[int] = mapped_column(Integer)  # pence
    budget_max: Mapped[int] = mapped_column(Integer)  # pence
    gift_date: Mapped[date] = mapped_column(Date)
    message: Mapped[str | None] = mapped_column(Text)
    admin_name: Mapped[str] = mapped_column(String(60))
    admin_email: Mapped[str] = mapped_column(String(254))
    admin_token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    invite_token: Mapped[str] = mapped_column(String(64), unique=True)
    # What the organiser shares with friends, as typed, and its normalised form for lookup.
    codeword: Mapped[str] = mapped_column(String(40))
    codeword_key: Mapped[str] = mapped_column(String(40), unique=True)
    show_exclusions: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    draw_status: Mapped[str] = mapped_column(
        String(16), default="not_drawn", server_default="not_drawn"
    )
    drawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    admin_unsubscribed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    participants: Mapped[list["Participant"]] = relationship(
        back_populates="group",
        cascade="all, delete-orphan",
        order_by="Participant.id",
    )


class Participant(Base):
    __tablename__ = "participants"
    __table_args__ = (UniqueConstraint("group_id", "email", name="uq_participant_group_email"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    email: Mapped[str | None] = mapped_column(String(254))  # optional: only for emails
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    secret_surprise: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Null until the person joins via the invite link or first opens a link the admin sent.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    joined_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    unsubscribed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Last change to items or secret surprise; drives the giver's "updated" note.
    wishlist_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    group: Mapped[Group] = relationship(back_populates="participants")
    items: Mapped[list["WishlistItem"]] = relationship(
        back_populates="participant",
        cascade="all, delete-orphan",
        order_by="WishlistItem.sort_order",
    )


class Exclusion(Base):
    __tablename__ = "exclusions"
    __table_args__ = (
        UniqueConstraint("group_id", "giver_id", "giftee_id", name="uq_exclusion_pair"),
        CheckConstraint("giver_id <> giftee_id", name="exclusion_not_self"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    giver_id: Mapped[int] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"))
    giftee_id: Mapped[int] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"))


class Assignment(Base):
    __tablename__ = "assignments"
    __table_args__ = (
        UniqueConstraint("group_id", "draw_round", "giver_id", name="uq_assignment_giver"),
        UniqueConstraint("group_id", "draw_round", "giftee_id", name="uq_assignment_giftee"),
        CheckConstraint("giver_id <> giftee_id", name="assignment_not_self"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    giver_id: Mapped[int] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"))
    giftee_id: Mapped[int] = mapped_column(ForeignKey("participants.id", ondelete="CASCADE"))
    draw_round: Mapped[int] = mapped_column(Integer)


class WishlistItem(Base):
    __tablename__ = "wishlist_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    participant_id: Mapped[int] = mapped_column(
        ForeignKey("participants.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    url: Mapped[str | None] = mapped_column(String(2048))
    price: Mapped[int | None] = mapped_column(Integer)  # pence
    image_url: Mapped[str | None] = mapped_column(String(2048))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    participant: Mapped[Participant] = relationship(back_populates="items")


class RateLimitHit(Base):
    """One request counted against a rate limit. key_hash is SHA-256 of bucket and key."""

    __tablename__ = "rate_limit_hits"
    __table_args__ = (Index("ix_rate_limit_lookup", "bucket", "key_hash", "hit_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    bucket: Mapped[str] = mapped_column(String(32))
    key_hash: Mapped[str] = mapped_column(String(64))
    hit_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Reminder(Base):
    """One row per reminder sent, or per wish-list-changed email waiting to go out.

    participant_id is null for emails to a group's admin.
    """

    __tablename__ = "reminders"
    __table_args__ = (Index("ix_reminders_lookup", "group_id", "participant_id", "type"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    participant_id: Mapped[int | None] = mapped_column(
        ForeignKey("participants.id", ondelete="CASCADE")
    )
    type: Mapped[str] = mapped_column(String(32))
    send_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class LinkToken(Base):
    """An extra working link for an admin or a participant, one per device or email.

    Created when someone opens a link from an email or the lost-link page, so a new link
    never breaks an older one. Only the SHA-256 hash is stored. participant_id is null
    for a group's admin link.
    """

    __tablename__ = "link_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    participant_id: Mapped[int | None] = mapped_column(
        ForeignKey("participants.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

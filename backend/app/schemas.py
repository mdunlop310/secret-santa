from datetime import date, datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    model_validator,
)

from app.codeword import MIN_KEY_LENGTH, codeword_key
from app.linkpreview import is_safe_image_url

MAX_BUDGET_PENCE = 1_000_000  # £10,000

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
GroupName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Message = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Pence = Annotated[int, Field(ge=0, le=MAX_BUDGET_PENCE)]
Email = Annotated[EmailStr, AfterValidator(str.lower)]


def _codeword(value: str) -> str:
    if len(codeword_key(value)) < MIN_KEY_LENGTH:
        raise ValueError(f"Use at least {MIN_KEY_LENGTH} letters or numbers")
    return value


Codeword = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=40),
    AfterValidator(_codeword),
]


def _not_in_past(value: date) -> date:
    if value < date.today():
        raise ValueError("The gift exchange date can't be in the past")
    return value


GiftDate = Annotated[date, AfterValidator(_not_in_past)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BudgetMixin:
    budget_min: int | None
    budget_max: int | None

    @model_validator(mode="after")
    def _budget_order(self):  # type: ignore[no-untyped-def]
        if (
            self.budget_min is not None
            and self.budget_max is not None
            and self.budget_max < self.budget_min
        ):
            raise ValueError("Max budget must be at least the min budget")
        return self


class GroupCreate(BudgetMixin, StrictModel):
    name: GroupName
    gift_date: GiftDate
    budget_min: Pence
    budget_max: Pence
    message: Message | None = None
    codeword: Codeword
    admin_name: Name
    admin_email: Email
    admin_participates: bool = True


class GroupCreated(BaseModel):
    group_id: int
    admin_link: str
    invite_link: str


class GroupUpdate(BudgetMixin, StrictModel):
    name: GroupName | None = None
    gift_date: GiftDate | None = None
    budget_min: Pence | None = None
    budget_max: Pence | None = None
    message: Message | None = None
    codeword: Codeword | None = None
    show_exclusions: bool | None = None


class GroupPublic(BaseModel):
    """What any member of the group may see."""

    id: int
    name: str
    gift_date: date
    budget_min: int
    budget_max: int
    message: str | None
    admin_name: str
    draw_status: str
    days_to_go: int


ParticipantStatus = Literal["invited", "joined", "wish_list_in"]


class ParticipantSummary(BaseModel):
    id: int
    name: str
    status: ParticipantStatus
    is_admin: bool


class AdminGroup(GroupPublic):
    codeword: str
    invite_link: str
    drawn_at: datetime | None
    show_exclusions: bool
    exclusion_pair_count: int
    participants: list[ParticipantSummary]


class InvitePreview(BaseModel):
    group_name: str
    admin_name: str
    gift_date: date
    budget_min: int
    budget_max: int
    message: str | None


class JoinRequest(StrictModel):
    name: Name
    email: Email | None = None


class EnterRequest(StrictModel):
    codeword: str = Field(max_length=40)


class PickRequest(EnterRequest):
    participant_id: int


class CodewordJoinRequest(EnterRequest):
    name: Name
    email: Email | None = None


class EnteredGroup(InvitePreview):
    """What someone holding the codeword sees: the group and everyone's names."""

    draw_status: str
    people: list["PersonRef"]


class EnteredLink(BaseModel):
    link: str


class JoinResult(BaseModel):
    status: Literal["joined", "sent"]
    participant_link: str | None = None


class LostLinkRequest(StrictModel):
    email: Email


class OpenedLink(BaseModel):
    kind: Literal["admin", "participant"]
    link: str


class AddParticipant(StrictModel):
    name: Name
    email: Email | None = None
    confirm_redraw: bool = False


class WishlistItemOut(BaseModel):
    id: int
    title: str
    url: str | None
    price: int | None
    image_url: str | None


class Me(BaseModel):
    id: int
    name: str
    is_admin: bool
    secret_surprise: bool
    group: GroupPublic
    items: list[WishlistItemOut]


MAX_ITEMS = 50


def _http_url(value: str) -> str:
    """Only plain http(s) links: no javascript:, data: or credentials in the URL."""
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("Enter a link starting with http:// or https://")
    if parts.username or parts.password:
        raise ValueError("Links can't contain a username or password")
    return value


HttpUrl = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2048),
    AfterValidator(_http_url),
]


def _image_url(value: str) -> str:
    if not is_safe_image_url(value):
        raise ValueError("Unsupported image link")
    return value


ImageUrl = Annotated[HttpUrl, AfterValidator(_image_url)]
ItemTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class ItemCreate(StrictModel):
    title: ItemTitle
    url: HttpUrl | None = None
    price: Pence | None = None
    image_url: ImageUrl | None = None


class ItemUpdate(StrictModel):
    title: ItemTitle | None = None
    url: HttpUrl | None = None
    price: Pence | None = None
    image_url: ImageUrl | None = None


class ItemOrder(StrictModel):
    ids: list[int] = Field(max_length=MAX_ITEMS)


class MeUpdate(StrictModel):
    name: Name | None = None
    secret_surprise: bool | None = None


class LinkPreviewRequest(StrictModel):
    url: HttpUrl


class LinkPreviewOut(BaseModel):
    title: str | None = None
    image_url: str | None = None


class ExclusionPair(BaseModel):
    giver_id: int
    giftee_id: int


class PersonRef(BaseModel):
    id: int
    name: str


class Exclusions(BaseModel):
    show_exclusions: bool
    participants: list[PersonRef]
    pairs: list[ExclusionPair]


class ExclusionsUpdate(StrictModel):
    pairs: list[ExclusionPair] = Field(max_length=50 * 49)
    show_exclusions: bool | None = None


class ExclusionsCheckRequest(StrictModel):
    pairs: list[ExclusionPair] = Field(max_length=50 * 49)


class BottleneckOut(BaseModel):
    side: Literal["give", "receive"]
    people: list[int]
    options: list[int]


class ExclusionsCheck(BaseModel):
    possible: bool
    reason: Literal["too_few", "stuck"] | None = None
    bottleneck: BottleneckOut | None = None


class DrawRequest(StrictModel):
    confirm_redraw: bool = False


class DrawResult(BaseModel):
    """Deliberately says nothing about who has whom."""

    draw_status: str
    drawn_at: datetime | None
    participant_count: int


class GifteeOut(BaseModel):
    name: str
    secret_surprise: bool
    items: list[WishlistItemOut]
    updated_at: datetime | None
    updated_since_draw: bool


class GifteeResponse(BaseModel):
    drawn: bool
    giftee: GifteeOut | None = None


EnteredGroup.model_rebuild()

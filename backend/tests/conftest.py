import itertools
import os
import re
from collections.abc import Iterator
from datetime import date, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base, get_db
from app.email import MemoryEmailSender, get_email_sender
from app.main import create_app

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://santa:santa@localhost:5432/santa_test"
)
BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def engine():
    engine = create_engine(TEST_DATABASE_URL)
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public"))
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.attributes["database_url"] = TEST_DATABASE_URL
    command.upgrade(cfg, "head")
    yield engine
    engine.dispose()


@pytest.fixture
def db(engine) -> Iterator[Session]:
    tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    with sessionmaker(bind=engine, expire_on_commit=False)() as session:
        yield session


@pytest.fixture
def outbox() -> MemoryEmailSender:
    return MemoryEmailSender()


@pytest.fixture
def client(engine, db, outbox) -> Iterator[TestClient]:
    app = create_app()
    factory = sessionmaker(bind=engine, expire_on_commit=False)

    def override_db() -> Iterator[Session]:
        with factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_email_sender] = lambda: outbox
    with TestClient(app) as c:
        yield c


def future(days: int = 49) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


_codewords = itertools.count(1)


def group_payload(**overrides) -> dict:
    payload = {
        "codeword": f"jingle {next(_codewords)}",
        "name": "Family Secret Santa",
        "gift_date": future(),
        "budget_min": 1500,
        "budget_max": 2500,
        "message": "One gift each.",
        "admin_name": "Sam",
        "admin_email": "sam@example.com",
        "admin_participates": True,
    }
    payload.update(overrides)
    return payload


def token_from(link: str) -> str:
    return link.rstrip("/").rsplit("/", 1)[1]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def link_in(text_body: str, kind: str) -> str:
    match = re.search(rf"https?://\S+/{kind}/[A-Za-z0-9_-]+", text_body)
    assert match, f"no /{kind}/ link in email"
    return match.group(0)


class Group:
    """A created group with handy tokens."""

    def __init__(self, client: TestClient, **overrides) -> None:
        response = client.post("/groups", json=group_payload(**overrides))
        assert response.status_code == 201, response.text
        self.data = response.json()
        self.id = self.data["group_id"]
        self.admin = token_from(self.data["admin_link"])
        self.invite = token_from(self.data["invite_link"])
        # The organiser's admin link is also their participant link when they take part.
        participates = group_payload(**overrides)["admin_participates"]
        self.admin_participant = self.admin if participates else None


@pytest.fixture
def make_group(client):
    return lambda **overrides: Group(client, **overrides)


def join(client: TestClient, outbox: MemoryEmailSender, invite: str, name: str, email: str) -> str:
    """Join via invite and return the new personal token, checking the email copy."""
    response = client.post(f"/join/{invite}", json={"name": name, "email": email})
    assert response.status_code == 201, response.text
    link = response.json()["participant_link"]
    assert link_in(outbox.outbox[-1].text, "p") == link
    return token_from(link)


def open_link_in(text_body: str) -> str:
    """The signed /open/ token from an email."""
    match = re.search(r"https?://\S+/open/([A-Za-z0-9.]+)\?to=\w+", text_body)
    assert match, "no /open/ link in email"
    return match.group(1)

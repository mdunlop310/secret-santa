"""Links in emails, the lost-link page, and extra links per device."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from app import access
from app.models import Group, LinkToken
from app.security import MAX_EXTRA_LINKS
from tests.conftest import bearer, join, open_link_in, token_from


def _open(client, token):
    return client.post(f"/links/open/{token}")


class TestOpenLinks:
    def test_draw_email_opens_the_giftee_page(self, client, outbox, make_group):
        g = make_group()
        alex = join(client, outbox, g.invite, "Alex", "alex@example.com")
        join(client, outbox, g.invite, "Priya", "priya@example.com")
        client.post(f"/groups/{g.id}/draw", headers=bearer(g.admin), json={})
        email = next(
            m for m in outbox.outbox if m.to == "alex@example.com" and "drawn" in m.subject
        )
        assert "?to=giftee" in email.text and "/join/" not in email.text

        opened = _open(client, open_link_in(email.text)).json()
        assert opened["kind"] == "participant"
        token = token_from(opened["link"])
        assert token != alex
        mine = client.get("/me/giftee", headers=bearer(token)).json()
        assert mine == client.get("/me/giftee", headers=bearer(alex)).json()

    def test_organisers_emails_open_their_admin_link(self, client, outbox, make_group):
        g = make_group()
        for name in ("Alex", "Priya"):
            join(client, outbox, g.invite, name, f"{name.lower()}@example.com")
        client.post(f"/groups/{g.id}/draw", headers=bearer(g.admin), json={})
        email = next(m for m in outbox.outbox if m.to == "sam@example.com" and "drawn" in m.subject)
        opened = _open(client, open_link_in(email.text)).json()
        assert opened["kind"] == "admin" and "/g/" in opened["link"]
        token = token_from(opened["link"])
        assert client.get("/admin/group", headers=bearer(token)).status_code == 200
        assert client.get("/me/giftee", headers=bearer(token)).status_code == 200
        # The original admin link still works.
        assert client.get("/admin/group", headers=bearer(g.admin)).status_code == 200

    def test_bad_expired_and_tampered_links_fail_alike(self, client, make_group):
        g = make_group()
        past = datetime.now(UTC) - timedelta(seconds=1)
        future = datetime.now(UTC) + timedelta(days=1)
        good = access.make_token("a", g.id, future)
        kind_ident, expires, signature = good.split(".")
        bad = [
            "nope",
            access.make_token("a", g.id, past),
            f"{kind_ident}.{int(expires) + 1}.{signature}",  # pushed expiry
            f"a{g.id + 1}.{expires}.{signature}",  # someone else's group
            access.make_token("a", 999999, future),  # no such group
            "x" * 200,
        ]
        responses = [_open(client, t) for t in bad]
        assert {r.status_code for r in responses} == {404}
        assert len({r.text for r in responses}) == 1
        assert _open(client, good).status_code == 200

    def test_old_extra_links_are_dropped_beyond_the_cap(self, client, make_group, db):
        g = make_group()
        token = access.make_token("a", g.id, datetime.now(UTC) + timedelta(days=1))
        links = [
            token_from(_open(client, token).json()["link"]) for _ in range(MAX_EXTRA_LINKS + 2)
        ]
        assert db.scalar(select(func.count()).select_from(LinkToken)) == MAX_EXTRA_LINKS
        assert client.get("/admin/group", headers=bearer(links[0])).status_code == 404
        assert client.get("/admin/group", headers=bearer(links[-1])).status_code == 200
        assert client.get("/admin/group", headers=bearer(g.admin)).status_code == 200

    def test_new_admin_link_drops_every_extra_admin_link(self, client, make_group, outbox):
        g = make_group()
        token = access.make_token("a", g.id, datetime.now(UTC) + timedelta(days=1))
        extra = token_from(_open(client, token).json()["link"])
        client.post(f"/groups/{g.id}/regenerate-admin-link", headers=bearer(g.admin))
        assert client.get("/admin/group", headers=bearer(extra)).status_code == 404

    def test_links_go_when_the_group_does(self, client, make_group, db):
        g = make_group()
        token = access.make_token("a", g.id, datetime.now(UTC) + timedelta(days=1))
        _open(client, token)
        client.delete("/admin/group", headers=bearer(g.admin))
        assert db.scalar(select(func.count()).select_from(LinkToken)) == 0
        assert _open(client, token).status_code == 404

    def test_email_links_last_until_the_group_is_deleted(self, client, make_group, db):
        g = make_group()
        group = db.get(Group, g.id)
        expires = access.until_group_deleted(group.gift_date)
        assert expires.date() == group.gift_date + timedelta(days=30)


class TestLostLinks:
    def test_sends_one_email_with_a_link_per_group(self, client, outbox, make_group):
        mine = make_group(name="Work", admin_email="alex@example.com", admin_name="Alex")
        other = make_group(name="Family")
        join(client, outbox, other.invite, "Alex", "alex@example.com")
        outbox.outbox.clear()

        response = client.post("/links/lost", json={"email": "Alex@Example.com"})
        assert response.status_code == 202 and response.json() == {"status": "sent"}
        (email,) = outbox.outbox
        assert email.to == "alex@example.com"
        assert "Open Work" in email.text and "Open Family" in email.text
        tokens = [
            line.split("/open/")[1].split("?")[0]
            for line in email.text.splitlines()
            if "/open/" in line
        ]
        assert len(tokens) == 2  # the organiser's link covers their own wish list
        kinds = sorted(_open(client, t).json()["kind"] for t in tokens)
        assert kinds == ["admin", "participant"]
        assert mine.id != other.id

    def test_unknown_email_gets_the_same_answer_and_no_email(self, client, outbox, make_group):
        make_group()
        outbox.outbox.clear()
        response = client.post("/links/lost", json={"email": "who@example.com"})
        assert response.status_code == 202 and response.json() == {"status": "sent"}
        assert outbox.outbox == []

    def test_lost_links_expire_after_a_day(self, client, outbox, make_group):
        make_group()
        outbox.outbox.clear()
        client.post("/links/lost", json={"email": "sam@example.com"})
        token = open_link_in(outbox.outbox[0].text)
        assert access.parse_token(token) is not None
        later = datetime.now(UTC) + access.LOST_LINK_LIFETIME + timedelta(minutes=1)
        assert access.parse_token(token, later) is None

    def test_rate_limited(self, client, make_group, monkeypatch):
        from app.config import get_settings

        make_group()
        monkeypatch.setattr(get_settings(), "rate_limit_email_send", 2)
        codes = [
            client.post("/links/lost", json={"email": "sam@example.com"}).status_code
            for _ in range(3)
        ]
        assert codes[-1] == 429

    def test_validation(self, client):
        assert client.post("/links/lost", json={"email": "nope"}).status_code == 422
        assert client.post("/links/lost", json={}).status_code == 422


class TestReminderLinks:
    def test_reminders_open_straight_to_the_right_page(self, client, outbox, make_group, db):
        from app.jobs import run

        g = make_group()
        join(client, outbox, g.invite, "Alex", "alex@example.com")
        outbox.outbox.clear()
        # Midday, so the daily reminders run whatever time the test itself runs.
        run(db, outbox, (datetime.now(UTC) + timedelta(days=5)).replace(hour=12))
        nudges = [m for m in outbox.outbox if "Add your wish list" in m.subject]
        assert nudges, [m.subject for m in outbox.outbox]
        for message in nudges:
            assert "/join/" not in message.text
            assert _open(client, open_link_in(message.text)).status_code == 200

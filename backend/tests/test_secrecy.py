"""Nobody, including the admin, can learn who has whom, except each giver about themselves.

Walks every API route as the admin, as every participant and with no token, after a
draw with exclusions and wish lists in place, then checks responses, emails and logs.
Adding a route without listing it in ROUTES fails this test on purpose.

The organiser's admin link doubles as their own participant link when they take part,
so it may show their own giftee, exactly like any other participant's link, and nothing
more. When they don't take part, it shows no giftee and no wish list at all.
"""

import json
import logging

import pytest
from sqlalchemy import select

from app.main import create_app
from app.models import Assignment
from tests.conftest import bearer, join

PEOPLE = ("Sam", "Alex", "Priya", "Jo", "Mia")

# (method, path) -> how to call it. Path parameters are filled in per run.
# Bodies are valid but harmless: they must not change the draw.
ROUTES = {
    ("GET", "/health"): {},
    ("POST", "/groups"): {"skip_auth_matrix": True},  # creates a separate group
    ("GET", "/admin/group"): {},
    ("GET", "/groups/{group_id}"): {},
    ("PATCH", "/groups/{group_id}"): {"json": {}},
    ("POST", "/groups/{group_id}/participants"): {"skip_auth_matrix": True},  # forces a redraw
    ("POST", "/groups/{group_id}/regenerate-admin-link"): {"skip_auth_matrix": True},
    ("GET", "/join/{invite_token}"): {},
    ("POST", "/join/{invite_token}"): {"skip_auth_matrix": True},  # adds a person
    ("POST", "/enter"): {"json": {"codeword": "not-this-one"}},
    ("POST", "/enter/pick"): {"json": {"codeword": "not-this-one", "participant_id": 1}},
    ("POST", "/enter/join"): {"skip_auth_matrix": True},  # adds a person
    ("POST", "/links/open/{token}"): {},
    ("POST", "/links/lost"): {"json": {"email": "nobody@example.com"}},
    ("GET", "/me"): {},
    ("PUT", "/me"): {"json": {}},
    ("POST", "/me/items"): {"skip_auth_matrix": True},
    ("PATCH", "/me/items/{item_id}"): {"json": {}},
    ("DELETE", "/me/items/{item_id}"): {"skip_auth_matrix": True},
    ("PUT", "/me/items/order"): {"skip_auth_matrix": True},
    ("POST", "/link-preview"): {"json": {"url": "http://127.0.0.1/"}},
    ("GET", "/groups/{group_id}/exclusions"): {},
    ("PUT", "/groups/{group_id}/exclusions"): {"skip_auth_matrix": True},
    ("POST", "/groups/{group_id}/exclusions/check"): {"json": {"pairs": []}},
    ("POST", "/groups/{group_id}/draw"): {"json": {"confirm_redraw": False}},
    ("DELETE", "/groups/{group_id}/participants/{participant_id}"): {"skip_auth_matrix": True},
    ("GET", "/me/giftee"): {},
    ("DELETE", "/me"): {"skip_auth_matrix": True},  # deletes the caller
    ("DELETE", "/admin/group"): {"skip_auth_matrix": True},  # deletes everything
    ("POST", "/unsubscribe/{token}"): {},
    ("POST", "/internal/jobs/run"): {},
}


def test_every_route_is_listed():
    # The OpenAPI schema lists every route, including those on included routers.
    paths = create_app().openapi()["paths"]
    routes = {(method.upper(), path) for path, ops in paths.items() for method in ops}
    assert routes == set(ROUTES), "add new routes to ROUTES in test_secrecy.py"


def _pairs_in(value, found):
    """Collect every {giver_id, giftee_id}-like pair anywhere in a JSON value."""
    if isinstance(value, dict):
        if "giver_id" in value and "giftee_id" in value:
            found.add((value["giver_id"], value["giftee_id"]))
        for v in value.values():
            _pairs_in(v, found)
    elif isinstance(value, list):
        for v in value:
            _pairs_in(v, found)
    return found


@pytest.mark.parametrize("organiser_takes_part", [True, False])
def test_nothing_leaks_who_has_whom(client, db, outbox, make_group, caplog, organiser_takes_part):
    caplog.set_level(logging.DEBUG)
    g = make_group(
        admin_name="Sam", admin_email="sam@example.com", admin_participates=organiser_takes_part
    )
    tokens = {}
    if organiser_takes_part:
        tokens["Sam"] = g.admin_participant
    else:
        tokens["Sam"] = join(client, outbox, g.invite, "Sam", "sam.p@example.com")
    for name in PEOPLE[1:]:
        tokens[name] = join(client, outbox, g.invite, name, f"{name.lower()}@example.com")
    ids = {
        p["name"]: p["id"]
        for p in client.get("/admin/group", headers=bearer(g.admin)).json()["participants"]
    }
    names = {v: k for k, v in ids.items()}

    # Wish lists with distinctive titles, exclusions visible to participants, then a draw.
    item_ids = {}
    for name, token in tokens.items():
        item = client.post("/me/items", headers=bearer(token), json={"title": f"wish-of-{name}"})
        item_ids[name] = item.json()["id"]
    exclusions = [("Sam", "Alex"), ("Alex", "Sam"), ("Priya", "Jo")]
    client.put(
        f"/groups/{g.id}/exclusions",
        headers=bearer(g.admin),
        json={
            "pairs": [{"giver_id": ids[a], "giftee_id": ids[b]} for a, b in exclusions],
            "show_exclusions": True,
        },
    )
    draw = client.post(f"/groups/{g.id}/draw", headers=bearer(g.admin), json={})
    assert draw.status_code == 200

    db.expire_all()
    assigned = dict(
        db.execute(
            select(Assignment.giver_id, Assignment.giftee_id).where(Assignment.group_id == g.id)
        ).all()
    )
    assert len(assigned) == 5
    giftee_name = {names[gv]: names[gt] for gv, gt in assigned.items()}
    assignment_pairs = set(assigned.items())

    def call(method, path, token, spec, as_name):
        params = {
            "group_id": g.id,
            "invite_token": g.invite,
            "participant_id": ids["Mia"],
            "item_id": item_ids.get(as_name, item_ids["Sam"]),
            "token": "p1.00000000000000000000000000000000",
        }
        url = path.format(**params)
        headers = bearer(token) if token else {}
        return client.request(method, url, headers=headers, json=spec.get("json"))

    callers = {"admin": g.admin, "nobody": None, **{n: t for n, t in tokens.items()}}
    for (method, path), spec in ROUTES.items():
        if spec.get("skip_auth_matrix"):
            continue
        for caller, token in callers.items():
            response = call(method, path, token, spec, caller)
            text = response.text
            try:
                body = response.json()
            except ValueError:
                body = None

            # No response anywhere contains an assignment pair.
            assert not (_pairs_in(body, set()) & assignment_pairs), (method, path, caller)

            if caller == "admin" and organiser_takes_part:
                caller = "Sam"  # the admin link is also Sam's participant link
            if caller in ("admin", "nobody"):
                # The admin and strangers never see a giftee or any wish list.
                assert '"giftee"' not in text or body.get("giftee") is None, (path, caller)
                for name in PEOPLE:
                    assert f"wish-of-{name}" not in text, (method, path, caller)
            else:
                # A participant sees their own list and their giftee's, nobody else's.
                allowed = {f"wish-of-{caller}", f"wish-of-{giftee_name[caller]}"}
                for name in PEOPLE:
                    title = f"wish-of-{name}"
                    if title not in allowed:
                        assert title not in text, (method, path, caller, title)
                if (method, path) == ("GET", "/me/giftee"):
                    assert body["giftee"]["name"] == giftee_name[caller]
                else:
                    assert f"wish-of-{giftee_name[caller]}" not in text or path == "/me"

    # The draw itself still stands, untouched by the walk.
    db.expire_all()
    assert (
        dict(
            db.execute(
                select(Assignment.giver_id, Assignment.giftee_id).where(Assignment.group_id == g.id)
            ).all()
        )
        == assigned
    )

    # Emails: no draw email names the recipient's giftee.
    by_email = {f"{n.lower()}@example.com": n for n in PEOPLE}
    by_email["sam.p@example.com"] = "Sam"
    for message in outbox.outbox:
        recipient = by_email.get(message.to)
        if recipient and "drawn" in message.subject.lower():
            giftee = giftee_name[recipient]
            assert giftee not in message.text and giftee not in message.html

    # Logs: no tokens and no wish-list content.
    log_text = caplog.text + "".join(json.dumps(r.args, default=str) for r in caplog.records)
    for token in [g.admin, *tokens.values()]:
        assert token not in log_text
    for name in PEOPLE:
        assert f"wish-of-{name}" not in log_text


def test_old_rounds_do_not_survive_a_redraw(client, db, outbox, make_group):
    g = make_group()
    for name in PEOPLE[1:4]:
        join(client, outbox, g.invite, name, f"{name.lower()}@example.com")
    client.post(f"/groups/{g.id}/draw", headers=bearer(g.admin), json={})
    client.post(f"/groups/{g.id}/draw", headers=bearer(g.admin), json={"confirm_redraw": True})
    db.expire_all()
    rounds = db.scalars(select(Assignment.draw_round).where(Assignment.group_id == g.id)).all()
    assert set(rounds) == {2} and len(rounds) == 4

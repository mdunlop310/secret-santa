"""Getting in with a group codeword: pick your name, or join as someone new."""

from sqlalchemy import select

from app.config import get_settings
from app.models import Assignment
from tests.conftest import bearer, group_payload, token_from


def enter(client, codeword):
    return client.post("/enter", json={"codeword": codeword})


def pick(client, codeword, participant_id):
    return client.post("/enter/pick", json={"codeword": codeword, "participant_id": participant_id})


def codeword_join(client, codeword, name, email=None):
    body = {"codeword": codeword, "name": name}
    if email:
        body["email"] = email
    return client.post("/enter/join", json=body)


def test_codeword_shows_the_group_and_names(client, make_group):
    g = make_group(codeword="Dunlop Xmas", message="Bring snacks")
    body = enter(client, "dunlop-XMAS").json()  # case, spaces and dashes are ignored
    assert body["group_name"] == "Family Secret Santa"
    assert body["message"] == "Bring snacks"
    assert body["draw_status"] == "not_drawn"
    assert [p["name"] for p in body["people"]] == ["Sam"]
    assert client.get("/admin/group", headers=bearer(g.admin)).json()["codeword"] == "Dunlop Xmas"


def test_wrong_codeword(client, make_group):
    make_group(codeword="dunlop xmas")
    response = enter(client, "dunlop xmass")
    assert response.status_code == 404
    assert response.json()["detail"] == "No group has that codeword"
    assert enter(client, "").status_code == 404


def test_codewords_are_unique_and_long_enough(client, make_group):
    make_group(codeword="Jingle Bells")
    taken = client.post("/groups", json=group_payload(codeword="jingle-bells"))
    assert taken.status_code == 409
    assert taken.json()["detail"] == "That codeword is taken. Try another."
    assert client.post("/groups", json=group_payload(codeword="a-b-c")).status_code == 422


def test_join_with_codeword_no_email_needed(client, outbox, make_group):
    make_group(codeword="jingle")
    sent = len(outbox.outbox)
    response = codeword_join(client, "jingle", "Alex")
    assert response.status_code == 201
    token = token_from(response.json()["link"])
    assert client.get("/me", headers=bearer(token)).json()["name"] == "Alex"
    assert len(outbox.outbox) == sent  # no email given, none sent


def test_join_with_email_sends_a_copy(client, outbox, make_group):
    make_group(codeword="jingle")
    assert codeword_join(client, "jingle", "Alex", "alex@example.com").status_code == 201
    assert outbox.outbox[-1].to == "alex@example.com"


def test_names_are_unique_in_a_group(client, make_group):
    make_group(codeword="jingle", admin_name="Sam")
    response = codeword_join(client, "jingle", "sam")
    assert response.status_code == 409
    assert "Pick your name" in response.json()["detail"]


def test_pick_your_name_gets_you_in(client, make_group):
    g = make_group(codeword="jingle")
    codeword_join(client, "jingle", "Alex")
    alex = next(p for p in enter(client, "jingle").json()["people"] if p["name"] == "Alex")
    response = pick(client, "jingle", alex["id"])
    assert response.status_code == 200
    token = token_from(response.json()["link"])
    client.post("/me/items", headers=bearer(token), json={"title": "Socks"})
    assert client.get("/me", headers=bearer(token)).json()["items"][0]["title"] == "Socks"
    # Picking again (another device) gives another working link; the first still works.
    again = token_from(pick(client, "jingle", alex["id"]).json()["link"])
    assert client.get("/me", headers=bearer(again)).status_code == 200
    assert client.get("/me", headers=bearer(token)).status_code == 200
    # Picking a name never gives admin access.
    assert client.get("/admin/group", headers=bearer(token)).status_code == 404
    assert client.get("/admin/group", headers=bearer(g.admin)).status_code == 200


def test_pick_needs_that_groups_codeword(client, make_group):
    make_group(codeword="jingle")
    make_group(codeword="tinsel")
    sam = enter(client, "jingle").json()["people"][0]
    assert pick(client, "tinsel", sam["id"]).status_code == 404
    assert pick(client, "jingle", sam["id"]).status_code == 200


def test_picked_link_shows_only_your_own_giftee(client, db, make_group):
    g = make_group(codeword="jingle")
    for name in ("Alex", "Priya", "Jo"):
        codeword_join(client, "jingle", name)
    assert client.post(f"/groups/{g.id}/draw", headers=bearer(g.admin), json={}).status_code == 200
    entered = enter(client, "jingle")
    assert "giftee" not in entered.text
    names = {p["id"]: p["name"] for p in entered.json()["people"]}
    assigned = dict(
        db.execute(
            select(Assignment.giver_id, Assignment.giftee_id).where(Assignment.group_id == g.id)
        ).all()
    )
    for giver, giftee in assigned.items():
        token = token_from(pick(client, "jingle", giver).json()["link"])
        body = client.get("/me/giftee", headers=bearer(token)).json()
        assert body["giftee"]["name"] == names[giftee]


def test_no_joining_after_the_draw(client, make_group):
    g = make_group(codeword="jingle")
    for name in ("Alex", "Priya"):
        codeword_join(client, "jingle", name)
    client.post(f"/groups/{g.id}/draw", headers=bearer(g.admin), json={})
    assert enter(client, "jingle").json()["draw_status"] == "drawn"
    assert codeword_join(client, "jingle", "Late").status_code == 409


def test_organiser_picked_by_name_cannot_leave(client, make_group):
    make_group(codeword="jingle", admin_name="Sam")
    sam = enter(client, "jingle").json()["people"][0]
    token = token_from(pick(client, "jingle", sam["id"]).json()["link"])
    assert client.delete("/me", headers=bearer(token)).status_code == 409


def test_organiser_can_change_the_codeword(client, make_group):
    g = make_group(codeword="jingle")
    make_group(codeword="tinsel")
    url = f"/groups/{g.id}"
    headers = bearer(g.admin)
    assert client.patch(url, headers=headers, json={"codeword": "Tinsel"}).status_code == 409
    assert client.patch(url, headers=headers, json={"codeword": "Holly"}).status_code == 200
    assert enter(client, "holly").status_code == 200
    assert enter(client, "jingle").status_code == 404


def test_guessing_is_rate_limited(client, make_group, monkeypatch):
    monkeypatch.setattr(get_settings(), "rate_limit_codeword", 3)
    make_group(codeword="jingle")
    for _ in range(3):
        assert enter(client, "wrong-guess").status_code == 404
    assert enter(client, "jingle").status_code == 429


def test_admin_can_add_someone_without_email(client, outbox, make_group):
    g = make_group(codeword="jingle")
    sent = len(outbox.outbox)
    response = client.post(
        f"/groups/{g.id}/participants", headers=bearer(g.admin), json={"name": "Gran"}
    )
    assert response.status_code == 201
    assert len(outbox.outbox) == sent
    assert "Gran" in [p["name"] for p in enter(client, "jingle").json()["people"]]

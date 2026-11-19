"""The web endpoints, with the sign-in check replaced. Service behavior is in test_walkthrough_service."""
import pytest
from fastapi.testclient import TestClient

from walkthrough.api import build_api


def verify(token, event_id):
    if token == "guest":
        raise PermissionError("Only hosts can make Walkthrough videos.")
    if token == "expired":
        raise PermissionError("Your sign-in expired. Reload the page and try again.")
    if token == "cohost":
        return "cohost1", {"name": "Party", "ownerUid": "host1"}, False
    if token == "cohost-allowed":
        return "cohost1", {"name": "Party", "ownerUid": "host1", "flowCohosts": True}, False
    if token == "invited-cohost":  # invited to Flow (so is_admin is true), but not a real admin
        return "cohost1", {"name": "Party", "ownerUid": "host1"}, True, None, False
    return ("admin1" if token == "admin" else "host1"), {"name": "Party", "ownerUid": "host1"}, token == "admin"


@pytest.fixture
def api(world):
    world.configure()
    world.add_event()
    return world, TestClient(build_api(lambda: world.svc, verify, origins=["https://share.get2.one"],
                                       origin_regex=r"https://get2-?share-[a-z0-9-]+\.vercel\.app"))


BODY = {"eventId": "ev1", "photoIds": ["p0", "p1", "p2", "p3"], "presetId": "15s", "aspect": "9:16",
        "acceptedNotice": True, "noticeVersion": 2, "requestId": "r1"}
H = {"Authorization": "Bearer host"}


@pytest.mark.parametrize("path,body", [
    ("/create", BODY), ("/redo", {"eventId": "ev1", "walkthroughId": "w", "clipIndex": 0}),
    ("/approve", {"eventId": "ev1", "walkthroughId": "w"}), ("/unpublish", {"eventId": "ev1", "walkthroughId": "w"}),
    ("/delete", {"eventId": "ev1", "walkthroughId": "w"}),
])
def test_every_endpoint_needs_a_host(api, path, body):
    _, client = api
    assert client.post(path, json=body).status_code == 401
    r = client.post(path, json=body, headers={"Authorization": "Bearer guest"})
    assert r.status_code == 403 and "hosts" in r.json()["detail"]


def test_create_approve_unpublish_delete(api):
    world, client = api
    r = client.post("/create", json=BODY, headers=H)
    assert r.status_code == 200
    wid = r.json()["id"]
    world.svc.run("ev1", wid)
    one = {"eventId": "ev1", "walkthroughId": wid}
    assert client.post("/approve", json=one, headers=H).json()["status"] == "published"
    assert world.doc("ev1", wid)["publishedBy"] == "host1"
    assert client.post("/unpublish", json=one, headers=H).json()["status"] == "preview"
    assert client.post("/redo", json={**one, "clipIndex": 0}, headers=H).status_code == 200
    world.svc.run("ev1", wid)
    assert client.post("/delete", json=one, headers=H).json()["status"] == "deleted"


def test_refusals_carry_a_message_the_app_shows(api):
    _, client = api
    r = client.post("/create", json={**BODY, "acceptedNotice": False}, headers=H)
    assert r.status_code == 400 and "notice" in r.json()["detail"]


def test_cors_allows_the_site_and_vercel_previews_only(api):
    _, client = api
    ask = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}
    for origin, ok in (("https://share.get2.one", True), ("https://get2-share-git-ai-walkthrough-get2.vercel.app", True),
                       ("https://evil.example", False)):
        r = client.options("/create", headers={**ask, "Origin": origin})
        assert (r.headers.get("access-control-allow-origin") == origin) is ok


# ---- Spending AI seconds is for the owner, unless the owner lets co-hosts in ----

REDO = {"eventId": "ev1", "walkthroughId": "w", "clipIndex": 0}


@pytest.mark.parametrize("path,body", [("/create", BODY), ("/redo", REDO)])
def test_a_cohost_cannot_spend_flow_time(api, path, body):
    _, client = api
    r = client.post(path, json=body, headers={"Authorization": "Bearer cohost"})
    assert r.status_code == 403 and "owner" in r.json()["detail"]


@pytest.mark.parametrize("path,body", [("/create", BODY), ("/redo", REDO)])
def test_an_invite_to_flow_does_not_make_a_cohost_the_owner(api, path, body):
    _, client = api
    r = client.post(path, json=body, headers={"Authorization": "Bearer invited-cohost"})
    assert r.status_code == 403 and "owner" in r.json()["detail"]


@pytest.mark.parametrize("path,body", [("/create", BODY), ("/redo", REDO)])
def test_a_cohost_can_spend_once_the_owner_allows_it(api, path, body):
    _, client = api
    r = client.post(path, json=body, headers={"Authorization": "Bearer cohost-allowed"})
    assert not (r.status_code == 403 and "owner" in r.json().get("detail", ""))


def test_a_cohost_can_still_see_the_meter(api):
    _, client = api
    r = client.post("/meter", json={"eventId": "ev1"}, headers={"Authorization": "Bearer cohost"})
    assert r.status_code == 200


def test_the_style_reaches_the_job(api):
    world, client = api
    r = client.post("/create", json={**BODY, "requestId": "style1", "styleId": "groove"}, headers={"Authorization": "Bearer admin"})
    assert r.status_code == 200, r.text
    wid = r.json()["id"]
    assert world.svc.wt_ref("ev1", wid).get().to_dict()["styleId"] == "groove"
    assert "energetic" in world.svc.job_ref("ev1", wid).get().to_dict()["prompt"]


def test_no_style_means_glide(api):
    world, client = api
    r = client.post("/create", json={**BODY, "requestId": "style2"}, headers={"Authorization": "Bearer admin"})
    assert r.status_code == 200, r.text
    assert world.svc.wt_ref("ev1", r.json()["id"]).get().to_dict()["styleId"] == "glide"


def test_an_unknown_style_is_refused(api):
    _, client = api
    r = client.post("/create", json={**BODY, "requestId": "style3", "styleId": "sparkle"}, headers={"Authorization": "Bearer admin"})
    assert r.status_code == 400 and "style" in r.json()["detail"]


def test_the_style_sets_how_the_video_is_cut(api):
    world, client = api
    r = client.post("/create", json={**BODY, "requestId": "cut-glow", "styleId": "glow"}, headers={"Authorization": "Bearer admin"})
    assert r.status_code == 200, r.text
    wid = r.json()["id"]
    wt, job = world.svc.wt_ref("ev1", wid).get().to_dict(), world.svc.job_ref("ev1", wid).get().to_dict()
    assert job["edit"] == {"crossfade": 0.0, "warm": True, "punch": False, "linger": 0.6}
    assert all(c["slowdown"] == 1.25 for c in wt["clips"])
    # Four photos: three 5-second clips slowed to 6.25 seconds each, each resting 0.6 seconds on its
    # last photo, then the 2.5-second end card.
    assert wt["seconds"] == pytest.approx(3 * (6.25 + 0.6) + 2.5)


# ---- The end card: always on free events, removable once the event has paid ----

def test_a_free_event_gets_the_end_card_even_when_asked_to_leave_it_off(api):
    world, client = api
    r = client.post("/create", json={**BODY, "requestId": "card1", "endCard": False}, headers={"Authorization": "Bearer admin"})
    assert r.status_code == 200, r.text
    wid = r.json()["id"]
    wt, job = world.svc.wt_ref("ev1", wid).get().to_dict(), world.svc.job_ref("ev1", wid).get().to_dict()
    assert wt["endCard"] is True and job["endCard"] == {"seconds": 2.5, "name": "Party"}
    assert wt["seconds"] == pytest.approx(15 + 2.5)


def test_the_end_card_is_on_unless_asked_otherwise(api):
    world, client = api
    r = client.post("/create", json={**BODY, "requestId": "card2"}, headers={"Authorization": "Bearer admin"})
    assert world.svc.wt_ref("ev1", r.json()["id"]).get().to_dict()["endCard"] is True


@pytest.mark.parametrize("features", [{"flowSeconds": 60}, {"pro": True}])
def test_a_paid_event_can_leave_the_end_card_off(api, features):
    world, client = api
    world.db.collection("features").document("ev1").set(features)
    r = client.post("/create", json={**BODY, "requestId": "card3", "endCard": False}, headers={"Authorization": "Bearer admin"})
    assert r.status_code == 200, r.text
    wid = r.json()["id"]
    wt, job = world.svc.wt_ref("ev1", wid).get().to_dict(), world.svc.job_ref("ev1", wid).get().to_dict()
    assert wt["endCard"] is False and job["endCard"] is None and wt["seconds"] == pytest.approx(15)


def test_the_meter_says_whether_the_end_card_can_come_off(api):
    world, client = api
    assert client.post("/meter", json={"eventId": "ev1"}, headers=H).json()["canRemoveEndCard"] is False
    world.db.collection("features").document("ev1").set({"flowSeconds": 60})
    assert client.post("/meter", json={"eventId": "ev1"}, headers=H).json()["canRemoveEndCard"] is True

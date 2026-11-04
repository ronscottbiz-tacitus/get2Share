"""The web endpoints, with the sign-in check replaced. Service behavior is in test_walkthrough_service."""
import pytest
from fastapi.testclient import TestClient

from walkthrough.api import build_api


def verify(token, event_id):
    if token == "guest":
        raise PermissionError("Only hosts can make Walkthrough videos.")
    if token == "expired":
        raise PermissionError("Your sign-in expired. Reload the page and try again.")
    return ("admin1" if token == "admin" else "host1"), {"name": "Party"}, token == "admin"


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

"""The Step In web endpoints (modal_app.api) with the GPU stubbed out: each allowed request starts
at most one job, refused ones start none, and /warm is throttled. Needs the modal package
(pip install modal); skipped without it."""
import pytest

modal = pytest.importorskip("modal")
pytest.importorskip("fastapi")

from fastapi.testclient import TestClient  # noqa: E402

from conftest import FakeDb  # noqa: E402
from stepin import firebase_io as fb  # noqa: E402
from stepin import limits  # noqa: E402

NOW = 1_790_000_000.0


@pytest.fixture
def api(monkeypatch):
    import modal_app

    state = {"t": NOW, "spawned": [], "warmed": 0, "who": ("host1", {}, False), "config": {}}
    db = FakeDb(lambda: state["t"])
    db.collection("events").document("ev1").collection("photos").document("p1").set({"url": "x"})
    db.collection("events").document("ev1").collection("photos").document("p2").set({"url": "x"})

    def step_in_host(token, eid):
        if token != "good":
            raise PermissionError("Only hosts can make Step In moments.")
        return state["who"]

    class Method:
        def __init__(self, on_spawn):
            self.on_spawn = on_spawn

        def spawn(self, *args):
            self.on_spawn(args)
            return type("Call", (), {"object_id": "fc-1"})()

    class StepInStub:
        make = Method(lambda a: state["spawned"].append(a))
        warm = Method(lambda a: state.__setitem__("warmed", state["warmed"] + 1))

    class ClsStub:
        @staticmethod
        def from_name(app, name):
            assert (app, name) == (modal_app.APP_NAME, "StepIn")
            return lambda: StepInStub()

    db.collection("config").document("stepIn").set({})
    monkeypatch.setattr(fb, "step_in_host", step_in_host)
    monkeypatch.setattr(fb, "db", lambda: db)
    monkeypatch.setattr(fb, "set_status", lambda *a, **k: None)
    monkeypatch.setattr(limits, "firestore_tx", lambda _db, fn: db.run_tx(fn))
    monkeypatch.setattr(modal_app.modal, "Cls", ClsStub)
    monkeypatch.setattr(modal_app.time, "time", lambda: state["t"])
    import firebase_admin.firestore
    monkeypatch.setattr(firebase_admin.firestore, "SERVER_TIMESTAMP", NOW, raising=False)

    web = modal_app.api._raw_f_ if hasattr(modal_app.api, "_raw_f_") else modal_app.api.get_raw_f()
    client = TestClient(web())
    client.state = state
    client.db = db
    return client


def post(api, path, body, token="good"):
    return api.post(path, json=body, headers={"Authorization": f"Bearer {token}"})


def test_redo_five_times_starts_one_job_while_it_runs(api):
    for _ in range(5):
        r = post(api, "/request", {"eventId": "ev1", "photoId": "p1", "redo": True})
        assert r.status_code == 200 and r.json() == {"status": "queued"}
    assert len(api.state["spawned"]) == 1


def test_not_a_host_starts_nothing(api):
    r = post(api, "/request", {"eventId": "ev1", "photoId": "p1"}, token="bad")
    assert r.status_code == 403 and "Only hosts" in r.json()["detail"]
    r = api.post("/request", json={"eventId": "ev1", "photoId": "p1"})
    assert r.status_code == 401
    assert api.state["spawned"] == []


def test_a_cap_answers_429_with_a_message_and_starts_nothing(api):
    api.db.collection("config").document("stepIn").set({"limits": {"perEvent": 1}})
    assert post(api, "/request", {"eventId": "ev1", "photoId": "p1"}).status_code == 200
    r = post(api, "/request", {"eventId": "ev1", "photoId": "p2"})
    assert r.status_code == 429 and "all the Step In moments it can (1)" in r.json()["detail"]
    assert len(api.state["spawned"]) == 1


def test_a_deleted_photo_is_404(api):
    r = post(api, "/request", {"eventId": "ev1", "photoId": "gone"})
    assert r.status_code == 404 and api.state["spawned"] == []


def test_warm_ten_times_warms_once(api):
    answers = [post(api, "/warm", {"eventId": "ev1"}).json() for _ in range(10)]
    assert answers[0] == {"warming": True} and all(a == {"warming": False} for a in answers[1:])
    assert api.state["warmed"] == 1
    api.state["t"] = NOW + limits.WARM_EVERY_SECONDS
    assert post(api, "/warm", {"eventId": "ev1"}).json() == {"warming": True}
    assert api.state["warmed"] == 2


def test_warm_needs_a_host(api):
    assert post(api, "/warm", {"eventId": "ev1"}, token="bad").status_code == 403
    assert api.state["warmed"] == 0

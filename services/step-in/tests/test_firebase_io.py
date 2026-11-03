"""verify_host keeps Step In's behavior exactly; verify_event_host checks hosting and nothing else;
cleanup includes walkthrough files."""
import sys
import types

import pytest

from stepin import firebase_io as fb


class Snap:
    def __init__(self, data):
        self._d, self.exists = data, data is not None
        self.id = "ev1"
        self.reference = "ref"

    def to_dict(self):
        return self._d


@pytest.fixture
def host_env(monkeypatch):
    """Fake sign-in and Firestore. Returns a dict the test changes."""
    state = {"claims": {"uid": "host1"}, "event": {"ownerUid": "owner", "hostUids": ["host1"]}, "stepIn": None, "pro": False}

    class Doc:
        def __init__(self, col, doc):
            self.col, self.doc_id = col, doc

        def get(self):
            if self.col == "events":
                return Snap(state["event"])
            if self.col == "config":
                return Snap(state["stepIn"])
            return Snap({"pro": True} if state["pro"] else None)

    class Db:
        def collection(self, col):
            return types.SimpleNamespace(document=lambda d: Doc(col, d))

    def verify_id_token(token, app=None):
        if token == "bad":
            raise ValueError("bad")
        return state["claims"]

    import firebase_admin.auth
    monkeypatch.setattr(firebase_admin.auth, "verify_id_token", verify_id_token)
    monkeypatch.setattr(fb, "db", lambda: Db())
    monkeypatch.setattr(fb, "app", lambda: None)
    return state


def test_verify_host_returns_uid_and_event(host_env):
    assert fb.verify_host("t", "ev1") == ("host1", host_env["event"])


def test_verify_host_messages_unchanged(host_env):
    with pytest.raises(PermissionError, match="Your sign-in expired"):
        fb.verify_host("bad", "ev1")
    host_env["claims"] = {"uid": "stranger"}
    with pytest.raises(PermissionError, match="Only hosts can make Step In moments."):
        fb.verify_host("t", "ev1")
    host_env["event"] = None
    with pytest.raises(PermissionError, match="That event no longer exists."):
        fb.verify_host("t", "ev1")


@pytest.mark.parametrize("step_in,pro,admin,allowed", [
    (None, False, False, True),                 # no doc: on for all hosts
    ({"allHosts": True}, False, False, True),
    ({"other": 1}, False, False, True),
    ({"allHosts": False}, False, False, False),
    ({"allHosts": False}, True, False, True),   # Pro event
    ({"allHosts": False}, False, True, True),   # admin
])
def test_verify_host_keeps_the_step_in_switch(host_env, step_in, pro, admin, allowed):
    host_env.update(stepIn=step_in, pro=pro)
    if admin:
        host_env["claims"] = {"uid": "x", "email": "RonScottBiz@gmail.com", "email_verified": True}
    if allowed:
        assert fb.verify_host("t", "ev1")[1] == host_env["event"]
    else:
        with pytest.raises(PermissionError, match="Step In is a Pro feature."):
            fb.verify_host("t", "ev1")


def test_pure_host_check_ignores_the_step_in_switch(host_env):
    host_env.update(stepIn={"allHosts": False})
    assert fb.verify_event_host("t", "ev1") == ("host1", host_env["event"], False)
    host_env["claims"] = {"uid": "owner"}
    assert fb.verify_event_host("t", "ev1")[0] == "owner"
    host_env["claims"] = {"uid": "x", "email": "ronscottbiz@gmail.com", "email_verified": True}
    assert fb.verify_event_host("t", "ev1")[2] is True
    host_env["claims"] = {"uid": "x", "email": "ronscottbiz@gmail.com", "email_verified": False}
    with pytest.raises(PermissionError, match="Nope"):
        fb.verify_event_host("t", "ev1", denied="Nope")


def test_cleanup_deletes_walkthrough_files(monkeypatch):
    asked = []

    class Blob:
        size = 10

        def __init__(self, name):
            self.name, self.deleted = name, False

        def delete(self):
            self.deleted = True

    blobs = {"events/ev1/": [Blob("events/ev1/u/a.jpg")], "moments/ev1/": [], "walkthroughs/ev1/": [Blob("walkthroughs/ev1/w/final-v1.mp4")]}

    class Bucket:
        def list_blobs(self, prefix):
            asked.append(prefix)
            return blobs[prefix]

    class Db:
        def collection(self, col):
            return types.SimpleNamespace(document=lambda d: types.SimpleNamespace(delete=lambda: None))

        def recursive_delete(self, ref):
            pass

    monkeypatch.setattr(fb, "bucket", lambda: Bucket())
    monkeypatch.setattr(fb, "db", lambda: Db())
    monkeypatch.setattr(fb, "expired_events", lambda: [Snap({"name": "Old"})])
    totals = fb.cleanup(live=False, log=lambda *_: None)
    assert totals["files"] == 2 and not blobs["walkthroughs/ev1/"][0].deleted, "report-only deletes nothing"
    assert "walkthroughs/ev1/" in asked
    fb.cleanup(live=True, log=lambda *_: None)
    assert blobs["walkthroughs/ev1/"][0].deleted

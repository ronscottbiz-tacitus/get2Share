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


# ------------------------------------------------------------------ load_photo reads our bucket only
BUCKET = "get2share.firebasestorage.app"


def link(path, bucket=BUCKET, host="firebasestorage.googleapis.com"):
    from urllib.parse import quote
    return f"https://{host}/v0/b/{bucket}/o/{quote(path, safe='')}?alt=media&token=abc-123"


@pytest.mark.parametrize("path", [
    "events/ev1/maya/1764000000000_IMG_1.jpg",
    "photos/maya/old.jpg",                       # the layout from before events
])
def test_photo_object_path_accepts_the_uploaders_own_file(path):
    assert fb.photo_object_path(link(path), "ev1", "maya", BUCKET) == path


@pytest.mark.parametrize("url", [
    link("events/ev1/jordan/a.jpg"),                    # another guest's file
    link("events/ev2/maya/a.jpg"),                      # another event's file
    link("moments/ev1/p1-in.sog"),                      # not a photo folder
    link("events/ev1/maya/sub/a.jpg"),                  # extra folder
    link("events/ev1/maya/../jordan/a.jpg"),
    link("events/ev1/maya/a.jpg", bucket="someone-else.appspot.com"),
    link("events/ev1/maya/a.jpg", host="example.com"),
    link("events/ev1/maya/a.jpg").replace("https://", "http://"),
    "http://169.254.169.254/computeMetadata/v1/",
    "https://example.com/p.jpg",
    "javascript:alert(1)",
    "",
])
def test_photo_object_path_refuses_everything_else(url):
    with pytest.raises(fb.UnusablePhoto):
        fb.photo_object_path(url, "ev1", "maya", BUCKET)


def test_photo_object_path_needs_an_uploader():
    with pytest.raises(fb.UnusablePhoto):
        fb.photo_object_path(link("events/ev1/maya/a.jpg"), "ev1", "", BUCKET)


def _jpeg_bytes():
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (4, 3), "red").save(buf, "JPEG")
    return buf.getvalue()


@pytest.fixture
def photo_env(monkeypatch):
    """A fake photo doc and bucket. Any network fetch fails the test."""
    state = {"photo": None, "blobs": {}, "reads": []}

    class Blob:
        def __init__(self, name, raw, content_type="image/jpeg"):
            self.name, self._raw, self.content_type, self.size = name, raw, content_type, len(raw)

        def download_as_bytes(self, end=None):
            state["reads"].append((self.name, end))
            return self._raw if end is None else self._raw[: end + 1]

    class Bucket:
        name = BUCKET

        def get_blob(self, path):
            return state["blobs"].get(path)

    class PhotoRef:
        def get(self):
            return Snap(state["photo"])

    def no_network(*a, **k):
        raise AssertionError("load_photo must not fetch over the network")

    import requests
    monkeypatch.setattr(requests, "get", no_network)
    monkeypatch.setattr(requests, "request", no_network)
    monkeypatch.setattr(fb, "bucket", lambda: Bucket())
    monkeypatch.setattr(fb, "photo_ref", lambda eid, pid: PhotoRef())
    state["Blob"] = Blob
    return state


def test_load_photo_reads_the_file_from_storage(photo_env):
    path = "events/ev1/maya/1_a.jpg"
    photo_env["blobs"][path] = photo_env["Blob"](path, _jpeg_bytes())
    photo_env["photo"] = {"url": link(path), "sessionId": "maya"}
    assert fb.load_photo("ev1", "p1").size == (4, 3)
    assert photo_env["reads"] == [(path, fb.MAX_PHOTO_BYTES - 1)]


def test_load_photo_still_reads_inline_photos(photo_env):
    import base64
    photo_env["photo"] = {"url": "data:image/jpeg;base64," + base64.b64encode(_jpeg_bytes()).decode(), "sessionId": "maya"}
    assert fb.load_photo("ev1", "p1").size == (4, 3)


@pytest.mark.parametrize("url", [
    "https://example.com/p.jpg",
    "http://127.0.0.1:8080/p.jpg",
    "data:text/html;base64,PGgxPmhpPC9oMT4=",
    "data:image/jpeg,notbase64",
    "not a url",
])
def test_load_photo_refuses_outside_links_without_fetching(photo_env, url):
    photo_env["photo"] = {"url": url, "sessionId": "maya"}
    with pytest.raises(fb.UnusablePhoto):
        fb.load_photo("ev1", "p1")
    assert photo_env["reads"] == []


def test_load_photo_refuses_another_guests_file(photo_env):
    path = "events/ev1/jordan/1_a.jpg"
    photo_env["blobs"][path] = photo_env["Blob"](path, _jpeg_bytes())
    photo_env["photo"] = {"url": link(path), "sessionId": "maya"}
    with pytest.raises(fb.UnusablePhoto):
        fb.load_photo("ev1", "p1")
    assert photo_env["reads"] == []


def test_load_photo_refuses_big_or_non_image_files(photo_env):
    path = "events/ev1/maya/1_a.jpg"
    photo_env["photo"] = {"url": link(path), "sessionId": "maya"}
    blob = photo_env["Blob"](path, _jpeg_bytes())
    blob.size = fb.MAX_PHOTO_BYTES + 1
    photo_env["blobs"][path] = blob
    with pytest.raises(fb.UnusablePhoto):
        fb.load_photo("ev1", "p1")
    photo_env["blobs"][path] = photo_env["Blob"](path, b"<html>", content_type="text/html")
    with pytest.raises(fb.UnusablePhoto):
        fb.load_photo("ev1", "p1")
    assert photo_env["reads"] == []


def test_load_photo_missing_file_reads_as_deleted(photo_env):
    photo_env["photo"] = {"url": link("events/ev1/maya/gone.jpg"), "sessionId": "maya"}
    with pytest.raises(FileNotFoundError, match="That photo was deleted."):
        fb.load_photo("ev1", "p1")
    photo_env["photo"] = None
    with pytest.raises(FileNotFoundError, match="That photo was deleted."):
        fb.load_photo("ev1", "p1")


def test_unusable_photo_shows_the_plain_message_in_step_in_and_flow():
    assert isinstance(fb.UnusablePhoto(), FileNotFoundError)

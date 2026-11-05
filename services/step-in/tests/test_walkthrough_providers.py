"""Adapter logic against a stand-in HTTP session. Nothing here checks the real services: their
request and response shapes are unverified, and these tests only pin what the adapters do."""
import json

import pytest

from walkthrough.providers import (
    ClipRequest, ClipStatus, ContentRejected, FakeProvider, FalProvider, GenerationFailed, HiggsfieldProvider,
    ProviderFailed, ProviderNotReady, TransientProviderError, VeoProvider, get_provider, selected_name,
)


class Resp:
    def __init__(self, status=200, body=None, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else json.dumps(body or {})

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class Session:
    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


@pytest.fixture
def req(tmp_path):
    start, end = tmp_path / "a.jpg", tmp_path / "b.jpg"
    start.write_bytes(b"AAA")
    end.write_bytes(b"BBB")
    return ClipRequest("w-0-1-1", "https://s/a.jpg", "https://s/b.jpg", str(start), str(end), 5, "720p", "9:16", "go")


def test_higgsfield_request_uses_key_header_and_turns_audio_off(req):
    s = Session(Resp(200, {"request_id": "x", "status_url": "https://api.higgsfield.ai/requests/x/status"}))
    p = HiggsfieldProvider(model="some/model", key="K", session=s)
    assert p.submit(req) == "https://api.higgsfield.ai/requests/x/status"
    method, url, kw = s.calls[0]
    assert (method, url) == ("POST", "https://api.higgsfield.ai/some/model")
    assert kw["headers"]["Authorization"] == "Key K"
    assert kw["json"]["image_url"] == "https://s/a.jpg"
    assert kw["json"]["end_image_url"] == "https://s/b.jpg"
    assert kw["json"]["generate_audio"] is False


def test_higgsfield_deletes_a_finished_request(req):
    s = Session(Resp(200, {"status": "deleted"}))
    HiggsfieldProvider(model="m", key="K", session=s).discard("https://api.higgsfield.ai/requests/abc/status")
    assert s.calls[0][0] == "DELETE" and s.calls[0][1] == "https://api.higgsfield.ai/requests/abc"


def test_only_a_verified_invited_email_counts():
    from walkthrough.runtime import email_is_invited as ok
    assert ok({"email": "Host@Example.com", "email_verified": True}, [" host@example.com "])
    assert not ok({"email": "host@example.com", "email_verified": False}, ["host@example.com"])
    assert not ok({"email": "other@example.com", "email_verified": True}, ["host@example.com"])
    assert not ok({"email_verified": True}, [""])
    assert not ok({"email": "host@example.com", "email_verified": True}, "host@example.com")


def test_grants_need_a_verified_email_valid_seconds_and_time_left():
    from datetime import datetime, timezone
    from walkthrough.runtime import active_grant_seconds as grant
    me = {"email": "Client@Example.com", "email_verified": True}
    soon = datetime(2030, 1, 1, tzinfo=timezone.utc)
    now = soon.timestamp() - 100
    assert grant(me, [{"email": " client@example.com ", "seconds": 120}], now) == 120.0
    assert grant(me, [{"email": "client@example.com", "seconds": 120, "until": soon}], now) == 120.0
    assert grant(me, [{"email": "client@example.com", "seconds": 120, "until": soon}], soon.timestamp()) is None
    assert grant(me, [{"email": "client@example.com", "seconds": 120, "until": "soon"}], now) is None
    assert grant({**me, "email_verified": False}, [{"email": "client@example.com", "seconds": 120}], now) is None
    assert grant(me, [{"email": "other@example.com", "seconds": 120}], now) is None
    for bad in (0, -5, "120", True, None):
        assert grant(me, [{"email": "client@example.com", "seconds": bad}], now) is None
    assert grant(me, "client@example.com", now) is None
    assert grant({"email_verified": True}, [{"email": "", "seconds": 120}], now) is None


def test_higgsfield_kling_uses_its_own_field_names(req):
    s = Session(Resp(200, {"status_url": "https://api.higgsfield.ai/requests/x/status"}))
    HiggsfieldProvider(model="kling-video/v3.0/std/image-to-video", key="K", session=s).submit(req)
    body = s.calls[0][2]["json"]
    assert body["last_image_url"] == req.end_url and body["sound"] == "off"
    assert "end_image_url" not in body and "generate_audio" not in body


def test_higgsfield_seedance_field_names(req):
    s = Session(Resp(200, {"status_url": "https://api.higgsfield.ai/requests/x/status"}))
    HiggsfieldProvider(model="bytedance/seedance-2.5/image-to-video", key="K", session=s).submit(req)
    body = s.calls[0][2]["json"]
    assert body["end_image_url"] == req.end_url and body["generate_audio"] is False and body["resolution"] == req.resolution
    assert "aspect_ratio" not in body and "last_image_url" not in body


@pytest.mark.parametrize("status,error", [("nsfw", ContentRejected), ("failed", GenerationFailed), ("canceled", GenerationFailed)])
def test_higgsfield_terminal_states(status, error):
    p = HiggsfieldProvider(model="m", key="K", session=Session(Resp(200, {"status": status})))
    with pytest.raises(error):
        p.check("https://status")


def test_higgsfield_completed_and_running():
    s = Session(Resp(200, {"status": "in_progress"}), Resp(200, {"status": "completed", "video": {"url": "https://v.mp4"}}))
    p = HiggsfieldProvider(model="m", key="K", session=s)
    assert p.check("u") == ClipStatus(False)
    assert p.check("u") == ClipStatus(True, "https://v.mp4")


def test_fal_fields_and_queue(req):
    s = Session(
        Resp(200, {"status_url": "https://q/status", "response_url": "https://q/res"}),
        Resp(200, {"status": "IN_PROGRESS"}),
        Resp(200, {"status": "COMPLETED"}), Resp(200, {"video": {"url": "https://v.mp4"}}),
    )
    p = FalProvider(model="owner/model", key="K", session=s)
    ref = p.submit(req)
    body = s.calls[0][2]["json"]
    assert body["image_url"] == "https://s/a.jpg" and body["end_image_url"] == "https://s/b.jpg"
    assert body["duration"] == 5 and body["resolution"] == "720p" and body["generate_audio"] is False
    assert p.check(ref) == ClipStatus(False)
    assert p.check(ref) == ClipStatus(True, "https://v.mp4")


def test_policy_refusal_at_submit_is_a_content_rejection(req):
    s = Session(Resp(422, text='{"detail":[{"type":"content_policy_violation"}]}'))
    with pytest.raises(ContentRejected):
        FalProvider(model="m", key="K", session=s).submit(req)


@pytest.mark.parametrize("answer,error", [
    (Resp(429, text="slow down"), TransientProviderError),
    (Resp(503, text="down"), TransientProviderError),
    (ConnectionError("nope"), TransientProviderError),
    (Resp(400, text="bad field"), ProviderFailed),
    (Resp(401, text="bad key"), ProviderFailed),
])
def test_http_errors_are_sorted(req, answer, error):
    with pytest.raises(error):
        HiggsfieldProvider(model="m", key="K", session=Session(answer)).submit(req)


def test_veo_sends_both_frames_inline_and_reads_the_result(req):
    s = Session(
        Resp(200, {"name": "operations/1"}),
        Resp(200, {"done": False}),
        Resp(200, {"done": True, "response": {"generateVideoResponse": {"generatedSamples": [{"video": {"uri": "https://v"}}]}}}),
    )
    p = VeoProvider(model="veo-x", key="K", session=s)
    ref = p.submit(req)
    instance = s.calls[0][2]["json"]["instances"][0]
    assert instance["image"]["bytesBase64Encoded"] == "QUFB" and instance["lastFrame"]["bytesBase64Encoded"] == "QkJC"
    assert s.calls[0][2]["headers"]["x-goog-api-key"] == "K"
    assert p.check(ref) == ClipStatus(False)
    assert p.check(ref) == ClipStatus(True, "https://v")


def test_veo_filter_is_a_content_rejection():
    s = Session(Resp(200, {"done": True, "response": {"generateVideoResponse": {"raiMediaFilteredCount": 1}}}))
    with pytest.raises(ContentRejected):
        VeoProvider(model="veo-x", key="K", session=s).check("operations/1")


def test_real_adapters_are_marked_unverified_and_refuse_without_the_switch():
    for name, cls, key in (("higgsfield", HiggsfieldProvider, "HIGGSFIELD_API_KEY"), ("fal", FalProvider, "FAL_KEY"), ("veo", VeoProvider, "GEMINI_API_KEY")):
        assert cls.verified is False
        with pytest.raises(ProviderNotReady):
            get_provider(name, "m", env={key: "k"})
        assert isinstance(get_provider(name, "m", env={key: "k", "WALKTHROUGH_ALLOW_UNVERIFIED": "1"}, session=Session()), cls)


def test_missing_key_or_model_is_not_ready():
    with pytest.raises(ProviderNotReady):
        get_provider("fal", "m", env={"WALKTHROUGH_ALLOW_UNVERIFIED": "1"})
    with pytest.raises(ProviderNotReady):
        FalProvider(model=None, key="k", session=Session())
    with pytest.raises(ProviderNotReady):
        get_provider("nope", env={})


def test_provider_choice_config_beats_env():
    assert selected_name("fal", {"WALKTHROUGH_PROVIDER": "veo"}) == "fal"
    assert selected_name(None, {"WALKTHROUGH_PROVIDER": "veo"}) == "veo"
    assert selected_name(None, {}) is None
    assert isinstance(get_provider("fake", env={}), FakeProvider)

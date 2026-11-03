"""
AI video providers behind one interface, chosen by config/walkthrough.provider or the
WALKTHROUGH_PROVIDER environment variable.

  fake        no network and no cost: crossfades the two frames with ffmpeg. For tests and
              dry runs on Modal.
  higgsfield  UNVERIFIED
  fal         UNVERIFIED
  veo         UNVERIFIED

UNVERIFIED means none of these request or response shapes has been run against the real
service; they were written from notes, and no paid API was called while building this. So
they refuse to run until WALKTHROUGH_ALLOW_UNVERIFIED=1 is in the Modal secret. Checking one
is the first step in WALKTHROUGH.md: try one clip, correct the adapter, set `verified = True`.

Results come from `check` as a download link. Links expire, so the job copies each clip to
Firebase Storage as soon as it is ready.
"""
from __future__ import annotations

import base64
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

POLICY_WORDS = ("nsfw", "content_policy", "content policy", "policy violation", "safety", "moderation",
                "prohibited", "face", "celebrity", "public figure", "minor", "sensitive", "responsible ai")


class ProviderError(Exception):
    pass


class ContentRejected(ProviderError):
    """The service refused these photos (faces, content rules). Trying again won't help."""


class TransientProviderError(ProviderError):
    """Busy, rate limited or network trouble. Worth another try; while polling, just poll again."""


class GenerationFailed(ProviderError):
    """The provider says this generation fell over (not a content refusal). Worth one more try."""


class ProviderFailed(ProviderError):
    """A real refusal, such as a bad request or bad key. Trying again won't help."""


class ProviderNotReady(ProviderError):
    """Not set up: no key, or an adapter nobody has checked against the real service yet."""


@dataclass(frozen=True)
class ClipRequest:
    key: str              # unique per attempt; sent as an idempotency key where supported
    start_url: str        # our cropped first frame, on a link the provider can fetch
    end_url: str
    start_path: str       # the same two frames on this machine
    end_path: str
    seconds: float
    resolution: str
    aspect: str
    prompt: str
    generate_audio: bool = False  # always silent


@dataclass(frozen=True)
class ClipStatus:
    done: bool
    url: str | None = None


class Provider:
    name = ""
    verified = False

    def submit(self, req: ClipRequest) -> str:
        """Start a clip. Returns a reference to pass to check()."""
        raise NotImplementedError

    def check(self, ref: str) -> ClipStatus:
        """Where a clip stands. Raises ContentRejected, GenerationFailed or TransientProviderError."""
        raise NotImplementedError

    def fetch(self, url: str, dest: str) -> None:
        """Download a finished clip."""
        raise NotImplementedError


class FakeProvider(Provider):
    """No network, no cost. `script` makes a clip misbehave, attempt by attempt, for tests:
    {clip_index: ["blocked" | "blocked_late" | "transient" | "transient_late" | "reject" | "ok"]}"""
    name = "fake"
    verified = True

    def __init__(self, out_dir: str | None = None, script: dict | None = None, polls: int = 1):
        import tempfile
        self.dir = Path(out_dir or tempfile.mkdtemp(prefix="fake-provider-"))
        self.script = script if script is not None else {}
        self.polls = polls
        self.submitted: list[ClipRequest] = []
        self.pending: dict[str, dict] = {}

    def submit(self, req: ClipRequest) -> str:
        if req.generate_audio:
            raise ProviderFailed("audio must stay off")
        clip = int(req.key.split("-")[-3])
        plan = self.script.get(clip, [])
        step = plan.pop(0) if plan else "ok"
        self.submitted.append(req)
        if step == "blocked":
            raise ContentRejected("fake: faces not allowed")
        if step == "transient":
            raise TransientProviderError("fake: busy")
        if step == "reject":
            raise ProviderFailed("fake: bad request")
        ref = f"fake-{len(self.submitted)}"
        # Keep its own copies, as a real service would: the worker's temp files can vanish.
        start, end = self.dir / f"{ref}-a.jpg", self.dir / f"{ref}-b.jpg"
        shutil.copyfile(req.start_path, start)
        shutil.copyfile(req.end_path, end)
        self.pending[ref] = {"req": req, "start": str(start), "end": str(end), "step": step, "polls": self.polls}
        return ref

    def check(self, ref: str) -> ClipStatus:
        job = self.pending.get(ref)
        if job is None:
            raise TransientProviderError("fake: job unknown")
        job["polls"] -= 1
        if job["polls"] > 0:
            return ClipStatus(False)
        if job["step"] == "blocked_late":
            raise ContentRejected("fake: nsfw")
        if job["step"] == "transient_late":
            raise GenerationFailed("fake: generation failed")
        from . import media
        req = job["req"]
        out = self.dir / f"{ref}.mp4"
        media.crossfade_clip(job["start"], job["end"], str(out), req.seconds)
        return ClipStatus(True, str(out))

    def fetch(self, url: str, dest: str) -> None:
        shutil.copyfile(url, dest)


class HttpProvider(Provider):
    env_key = ""

    def __init__(self, model: str | None = None, key: str | None = None, session=None):
        self.model = model or self.default_model()
        self.key = key if key is not None else os.environ.get(self.env_key, "")
        if not self.key:
            raise ProviderNotReady(f"{self.env_key} is not set.")
        if not self.model:
            raise ProviderNotReady(f"No model chosen for {self.name}. Set config/walkthrough.model.")
        if session is None:
            import requests
            session = requests.Session()
        self.session = session

    def default_model(self) -> str | None:
        return None

    def headers(self) -> dict:
        return {"Authorization": f"Key {self.key}", "Content-Type": "application/json"}

    def call(self, method: str, url: str, **kw) -> dict:
        kw.setdefault("timeout", 60)
        try:
            r = self.session.request(method, url, headers=self.headers(), **kw)
        except Exception as e:  # connection trouble, timeouts
            raise TransientProviderError(f"{self.name}: {type(e).__name__}") from e
        text = (getattr(r, "text", "") or "")[:1000]
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientProviderError(f"{self.name}: HTTP {r.status_code}")
        if r.status_code >= 400:
            if is_policy_text(text):
                raise ContentRejected(f"{self.name}: {text[:200]}")
            raise ProviderFailed(f"{self.name}: HTTP {r.status_code} {text[:200]}")
        try:
            return r.json()
        except ValueError as e:
            raise TransientProviderError(f"{self.name}: unreadable answer") from e

    def fetch(self, url: str, dest: str) -> None:
        try:
            r = self.session.request("GET", url, headers=self.fetch_headers(), stream=True, timeout=120)
            if r.status_code != 200:
                raise TransientProviderError(f"{self.name}: download HTTP {r.status_code}")
            with open(dest, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        except TransientProviderError:
            raise
        except Exception as e:
            raise TransientProviderError(f"{self.name}: download {type(e).__name__}") from e

    def fetch_headers(self) -> dict:
        return {}


def is_policy_text(text: str) -> bool:
    low = (text or "").lower()
    return any(w in low for w in POLICY_WORDS)


def video_url_from(body: dict) -> str | None:
    """Finds the video link in the shapes these services have been seen to use."""
    for holder in (body, body.get("response") or {}, body.get("data") or {}):
        video = holder.get("video")
        if isinstance(video, dict) and video.get("url"):
            return video["url"]
        if isinstance(video, str):
            return video
        if holder.get("video_url"):
            return holder["video_url"]
        for listed in (holder.get("videos"), holder.get("outputs"), holder.get("results")):
            if isinstance(listed, list) and listed:
                first = listed[0]
                if isinstance(first, str):
                    return first
                if isinstance(first, dict) and first.get("url"):
                    return first["url"]
    return None


class HiggsfieldProvider(HttpProvider):
    """UNVERIFIED until a real clip has run. POST https://api.higgsfield.ai/<model-path>, header
    Authorization: Key <key>, then poll status_url until completed, failed, nsfw or canceled.
    Field names follow Higgsfield's docs as of Nov 2026, and they differ by model. There's no
    aspect field for image-to-video, so the frames we send set the shape."""
    name = "higgsfield"
    env_key = "HIGGSFIELD_API_KEY"
    BASE = "https://api.higgsfield.ai"

    def default_model(self):
        return os.environ.get("HIGGSFIELD_MODEL_PATH")

    def body_for(self, req: ClipRequest) -> dict:
        base = {"prompt": req.prompt, "image_url": req.start_url, "duration": int(req.seconds)}
        if self.model.lstrip("/").startswith("kling-video"):
            return {**base, "last_image_url": req.end_url, "sound": "on" if req.generate_audio else "off"}
        return {**base, "end_image_url": req.end_url, "resolution": req.resolution, "generate_audio": req.generate_audio}

    def submit(self, req: ClipRequest) -> str:
        body = self.call("POST", f"{self.BASE}/{self.model.lstrip('/')}", json=self.body_for(req))
        ref = body.get("status_url")
        if not ref:
            raise ProviderFailed("higgsfield: no status_url in the answer")
        return ref

    def check(self, ref: str) -> ClipStatus:
        body = self.call("GET", ref)
        status = str(body.get("status") or "").lower()
        if status == "nsfw":
            raise ContentRejected("higgsfield: nsfw")
        if status in ("failed", "canceled", "cancelled"):
            if is_policy_text(str(body.get("error") or "")):
                raise ContentRejected(f"higgsfield: {body.get('error')}")
            raise GenerationFailed(f"higgsfield: {status}")
        if status == "completed":
            url = video_url_from(body)
            if not url:
                raise GenerationFailed("higgsfield: completed with no video link")
            return ClipStatus(True, url)
        return ClipStatus(False)


class FalProvider(HttpProvider):
    """UNVERIFIED. fal's queue API with image_url, end_image_url, duration, resolution and
    generate_audio. The model (config/walkthrough.model or FAL_MODEL) decides which fields apply."""
    name = "fal"
    env_key = "FAL_KEY"
    BASE = "https://queue.fal.run"

    def default_model(self):
        return os.environ.get("FAL_MODEL")

    def submit(self, req: ClipRequest) -> str:
        body = self.call("POST", f"{self.BASE}/{self.model.lstrip('/')}", json={
            "prompt": req.prompt,
            "image_url": req.start_url,
            "end_image_url": req.end_url,
            "duration": int(req.seconds),
            "resolution": req.resolution,
            "aspect_ratio": req.aspect,
            "generate_audio": req.generate_audio,
        })
        status_url, response_url = body.get("status_url"), body.get("response_url")
        if not status_url or not response_url:
            raise ProviderFailed("fal: no queue links in the answer")
        return f"{status_url}|{response_url}"

    def check(self, ref: str) -> ClipStatus:
        status_url, response_url = ref.split("|", 1)
        status = str(self.call("GET", status_url).get("status") or "").upper()
        if status in ("FAILED", "ERROR", "CANCELED", "CANCELLED"):
            raise GenerationFailed(f"fal: {status}")
        if status != "COMPLETED":
            return ClipStatus(False)
        result = self.call("GET", response_url)  # a refused clip answers 4xx here, which call() sorts out
        url = video_url_from(result)
        if not url:
            raise GenerationFailed("fal: completed with no video link")
        return ClipStatus(True, url)


class VeoProvider(HttpProvider):
    """UNVERIFIED. Google Veo through the Gemini API's predictLongRunning. Veo has its own list
    of allowed clip lengths: check that the preset's clipSeconds is on it. It may also add audio;
    the join step drops every audio track, so the final video stays silent regardless."""
    name = "veo"
    env_key = "GEMINI_API_KEY"
    BASE = "https://generativelanguage.googleapis.com/v1beta"

    def default_model(self):
        return os.environ.get("VEO_MODEL")

    def headers(self) -> dict:
        return {"x-goog-api-key": self.key, "Content-Type": "application/json"}

    fetch_headers = lambda self: {"x-goog-api-key": self.key}  # noqa: E731

    @staticmethod
    def _inline(path: str) -> dict:
        return {"bytesBase64Encoded": base64.b64encode(Path(path).read_bytes()).decode(), "mimeType": "image/jpeg"}

    def submit(self, req: ClipRequest) -> str:
        body = self.call("POST", f"{self.BASE}/models/{self.model}:predictLongRunning", json={
            "instances": [{
                "prompt": req.prompt,
                "image": self._inline(req.start_path),
                "lastFrame": self._inline(req.end_path),
            }],
            "parameters": {
                "aspectRatio": req.aspect,
                "durationSeconds": int(req.seconds),
                "resolution": req.resolution,
                "sampleCount": 1,
            },
        })
        if not body.get("name"):
            raise ProviderFailed("veo: no operation name in the answer")
        return body["name"]

    def check(self, ref: str) -> ClipStatus:
        body = self.call("GET", f"{self.BASE}/{ref}")
        if not body.get("done"):
            return ClipStatus(False)
        if body.get("error"):
            message = str(body["error"].get("message") or "")
            if is_policy_text(message):
                raise ContentRejected(f"veo: {message[:200]}")
            raise GenerationFailed(f"veo: {message[:200]}")
        result = (body.get("response") or {}).get("generateVideoResponse") or {}
        if result.get("raiMediaFilteredCount") or result.get("raiMediaFilteredReasons"):
            raise ContentRejected("veo: filtered")
        samples = result.get("generatedSamples") or []
        url = ((samples[0] or {}).get("video") or {}).get("uri") if samples else None
        if not url:
            raise GenerationFailed("veo: done with no video link")
        return ClipStatus(True, url)


REAL_PROVIDERS = {"higgsfield": HiggsfieldProvider, "fal": FalProvider, "veo": VeoProvider}


def selected_name(config_provider: str | None, env=os.environ) -> str | None:
    return config_provider or env.get("WALKTHROUGH_PROVIDER") or None


def get_provider(name: str, model: str | None = None, env=os.environ, session=None) -> Provider:
    if name == "fake":
        return FakeProvider()
    cls = REAL_PROVIDERS.get(name)
    if cls is None:
        raise ProviderNotReady(f"Unknown video provider: {name}")
    if not cls.verified and env.get("WALKTHROUGH_ALLOW_UNVERIFIED") != "1":
        raise ProviderNotReady(
            f"The {name} adapter hasn't been checked against the real service. "
            "See WALKTHROUGH.md before setting WALKTHROUGH_ALLOW_UNVERIFIED=1."
        )
    return cls(model=model, key=env.get(cls.env_key, ""), session=session)


__all__ = [
    "ClipRequest", "ClipStatus", "ContentRejected", "FakeProvider", "FalProvider", "GenerationFailed", "HiggsfieldProvider",
    "Provider", "ProviderError", "ProviderFailed", "ProviderNotReady", "TransientProviderError", "VeoProvider",
    "get_provider", "selected_name",
]

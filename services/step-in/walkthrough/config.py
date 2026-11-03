"""
Settings for Walkthrough videos. Everything lives in the Firestore doc config/walkthrough,
edited by an admin in the Firebase console. A missing doc or a bad value always means the
safe choice: off, admins only, built-in limits. See services/step-in/WALKTHROUGH.md.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

# Burned into every video and shown next to it in the app. Same text as src/walkthrough.ts.
LABEL = "AI-generated video. Some moments and details aren't real."
# The same words, split for vertical video, where one line would not fit.
LABEL_LINES = ("AI-generated video.", "Some moments and details aren't real.")
NOTICE_VERSION = 1

ASPECTS = ("9:16", "16:9")
RESOLUTIONS = ("720p", "480p")
MAX_PRESET_PHOTOS = 25  # a sanity cap on what config can ask for, not a product limit

DEFAULT_PRESETS = (
    {"id": "10s", "label": "10 sec", "photos": 3, "clipSeconds": 5},
    {"id": "15s", "label": "15 sec", "photos": 4, "clipSeconds": 5},
)
DEFAULT_PRESET = "15s"

# The host picks photos, and the photo count sets the length: each photo after the first adds a clip.
MIN_PHOTOS = 3
MAX_PHOTOS = 10
CLIP_SECONDS = 5
# Seconds of AI video a free account gets, once: a 15-second Flow and one 5-second redo.
FREE_ACCOUNT_SECONDS = 20

DEFAULT_LIMITS = {
    "videosPerEvent": 3,          # the meter is the real limit; these are backstops
    "redosPerEvent": 5,
    "videosPerHostPerMonth": 20,  # anyone with a Google account can make unlimited events
    "redosPerHostPerMonth": 30,
}
DEFAULT_MONTHLY_BUDGET_USD = 50.0

# US dollars per generated second, used to reserve money before anything is generated.
# UNVERIFIED ESTIMATES, deliberately on the high side: check them against each provider's
# current price page and override them with config/walkthrough.prices before real use.
DEFAULT_PRICES = {
    "fake": {"720p": 0.0, "480p": 0.0},
    "higgsfield": {"720p": 0.30, "480p": 0.15},
    "fal": {"720p": 0.30, "480p": 0.15},
    "veo": {"720p": 0.50, "480p": 0.50},
}

DEFAULT_PROMPT = (
    "A slow, smooth, handheld camera move through a real party, travelling from the first "
    "frame to the last frame. Keep every person, face and object exactly as they are. "
    "Do not add people, text or logos."
)


@dataclass(frozen=True)
class Preset:
    id: str
    label: str
    photos: int
    clip_seconds: float

    @property
    def clips(self) -> int:
        return self.photos - 1

    @property
    def seconds(self) -> float:
        return self.clips * self.clip_seconds


@dataclass(frozen=True)
class Config:
    enabled: bool = False
    all_hosts: bool = False
    provider: str | None = None
    model: str | None = None
    resolution: str = "720p"
    presets: tuple[Preset, ...] = ()
    default_preset: str = DEFAULT_PRESET
    limits: dict = field(default_factory=lambda: dict(DEFAULT_LIMITS))
    monthly_budget_usd: float = DEFAULT_MONTHLY_BUDGET_USD
    prices: dict = field(default_factory=lambda: dict(DEFAULT_PRICES))
    prompt: str = DEFAULT_PROMPT
    slowdown: tuple = ()     # per clip; a clip with no entry plays at normal speed
    hold_start: float = 0.0  # still (non-AI) seconds on the first photo
    hold_end: float = 0.0    # still (non-AI) seconds on the last photo
    hold_zoom: bool = False  # a gentle zoom during those still seconds
    min_photos: int = MIN_PHOTOS
    max_photos: int = MAX_PHOTOS
    clip_seconds: float = CLIP_SECONDS
    free_account_seconds: float = FREE_ACCOUNT_SECONDS

    def preset(self, preset_id: str | None) -> Preset | None:
        wanted = preset_id or self.default_preset
        return next((p for p in self.presets if p.id == wanted), None)

    def price_per_second(self, provider: str, resolution: str) -> float | None:
        """None when no price is known: the caller must refuse, never guess zero."""
        value = (self.prices.get(provider) or {}).get(resolution)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
            return None
        return float(value)

    def slowdown_for(self, clip_index: int) -> float:
        return self.slowdown[clip_index] if clip_index < len(self.slowdown) else 1.0


def _number(value, default, low=0.0, high=float("inf")):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return value if low <= value <= high else default


def _presets(raw) -> tuple[Preset, ...]:
    out = []
    for p in raw if isinstance(raw, (list, tuple)) else []:
        if not isinstance(p, dict) or not isinstance(p.get("id"), str):
            continue
        photos = _number(p.get("photos"), None, 2, MAX_PRESET_PHOTOS)
        clip_seconds = _number(p.get("clipSeconds"), None, 1, 30)
        if photos is None or clip_seconds is None or int(photos) != photos:
            continue
        out.append(Preset(p["id"], str(p.get("label") or p["id"]), int(photos), float(clip_seconds)))
    return tuple(out)


def parse_config(data: dict | None) -> Config:
    """config/walkthrough -> Config. A missing doc is off; only a literal true turns things on."""
    d = data or {}
    limits_in = d.get("limits") if isinstance(d.get("limits"), dict) else {}
    limits = {k: int(_number(limits_in.get(k), v)) for k, v in DEFAULT_LIMITS.items()}
    budget_in = d.get("budget") if isinstance(d.get("budget"), dict) else {}

    prices = {k: dict(v) for k, v in DEFAULT_PRICES.items()}
    if isinstance(d.get("prices"), dict):
        for provider, table in d["prices"].items():
            if isinstance(table, dict):
                prices.setdefault(provider, {}).update(table)

    presets = _presets(d.get("presets")) or _presets(list(DEFAULT_PRESETS))
    default_preset = d.get("defaultPreset") if isinstance(d.get("defaultPreset"), str) else DEFAULT_PRESET
    if not any(p.id == default_preset for p in presets):
        default_preset = presets[-1].id

    raw_slow = d.get("slowdown")
    if not isinstance(raw_slow, (list, tuple)):
        raw_slow = []
    hold = d.get("hold") if isinstance(d.get("hold"), dict) else {}

    photos_in = d.get("photos") if isinstance(d.get("photos"), dict) else {}
    meter_in = d.get("meter") if isinstance(d.get("meter"), dict) else {}
    min_photos = int(_number(photos_in.get("min"), MIN_PHOTOS, 2, MAX_PRESET_PHOTOS))
    max_photos = max(min_photos, int(_number(photos_in.get("max"), MAX_PHOTOS, 2, MAX_PRESET_PHOTOS)))

    return Config(
        min_photos=min_photos,
        max_photos=max_photos,
        clip_seconds=float(_number(d.get("clipSeconds"), CLIP_SECONDS, 1, 30)),
        free_account_seconds=float(_number(meter_in.get("freeAccountSeconds"), FREE_ACCOUNT_SECONDS, 0)),
        enabled=d.get("enabled") is True,
        all_hosts=d.get("allHosts") is True,
        provider=d.get("provider") if isinstance(d.get("provider"), str) and d.get("provider") else None,
        model=d.get("model") if isinstance(d.get("model"), str) and d.get("model") else None,
        resolution=d.get("resolution") if d.get("resolution") in RESOLUTIONS else "720p",
        presets=presets,
        default_preset=default_preset,
        limits=limits,
        monthly_budget_usd=float(_number(budget_in.get("monthlyUsd"), DEFAULT_MONTHLY_BUDGET_USD)),
        prices=prices,
        prompt=d.get("prompt") if isinstance(d.get("prompt"), str) and d.get("prompt").strip() else DEFAULT_PROMPT,
        slowdown=tuple(float(_number(x, 1.0, 1.0, 4.0)) for x in raw_slow),
        hold_start=float(_number(hold.get("startSeconds"), 0.0, 0.0, 5.0)),
        hold_end=float(_number(hold.get("endSeconds"), 0.0, 0.0, 5.0)),
        hold_zoom=hold.get("zoom") is True,
    )


def month_key(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m")


def size_for(aspect: str, resolution: str) -> tuple[int, int]:
    """Width and height. Both are even, as H.264 needs."""
    short = {"720p": 720, "480p": 480}[resolution]
    long = {"720p": 1280, "480p": 854}[resolution]
    return (short, long) if aspect == "9:16" else (long, short)

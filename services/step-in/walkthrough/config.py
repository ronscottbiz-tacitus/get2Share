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
NOTICE_VERSION = 2

ASPECTS = ("9:16", "16:9")
RESOLUTIONS = ("720p", "480p")
MAX_PRESET_PHOTOS = 25  # a sanity cap on what config can ask for, not a product limit

DEFAULT_PRESETS = (
    {"id": "10s", "label": "10 sec", "photos": 3, "clipSeconds": 5},
    {"id": "15s", "label": "15 sec", "photos": 4, "clipSeconds": 5},
)
DEFAULT_PRESET = "15s"

# A closing card on every Flow: the Get2Share name, the event's name and share.get2.one. It is
# how a shared video brings people back. Not AI, so it uses no AI seconds. Free events always
# have it; an event with paid Flow time or Pro can leave it off.
END_CARD_SECONDS = 2.5

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

# What hosts can buy. Seconds are AI seconds: the end card and still holds cost none.
# A Flow Pass belongs to one event and passes stack (two passes, twice the seconds); Pro is
# monthly. config/walkthrough.plans.<id>.{usd, seconds} overrides a price or an amount.
# Checkout is next. Until then a pass is added by hand: features/{eventId}.flowSeconds goes up by
# the pass's seconds. Paid seconds are their own limit: no per-event or per-host video caps, and
# they don't count against the monthly budget (that cap is for free and invited seconds).
DEFAULT_PLANS = (
    {"id": "flowPass", "name": "Flow Pass", "usd": 15, "seconds": 100, "per": "event"},
    {"id": "flowPassPlus", "name": "Flow Pass Plus", "usd": 29, "seconds": 200, "per": "event"},
    {"id": "pro", "name": "Pro", "usd": 49, "seconds": 400, "per": "month"},
)

# US dollars per generated second, used to reserve money before anything is generated.
# UNVERIFIED ESTIMATES, deliberately on the high side: check them against each provider's
# current price page and override them with config/walkthrough.prices before real use.
DEFAULT_PRICES = {
    "fake": {"720p": 0.0, "480p": 0.0},
    "higgsfield": {"720p": 0.30, "480p": 0.15},
    "fal": {"720p": 0.30, "480p": 0.15},
    "veo": {"720p": 0.50, "480p": 0.50},
}

# Every style ends with the same guard: the AI moves the camera, it doesn't change the people.
_KEEP = ("Keep every person, face and object exactly as they are. Keep each person's expression as it is "
         "in the photos: do not make anyone smile, laugh, talk or change their look. "
         "Do not add people, text or logos.")

DEFAULT_PROMPT = (
    "A slow, smooth, handheld camera move through a real party, travelling from the first "
    "frame to the last frame. " + _KEEP
)

# The looks a host can choose (same ids and names as FLOW_STYLES in src/walkthrough.ts).
# Glide is the original look; its words are `prompt` above, so an old config still works.
DEFAULT_STYLE = "glide"
DEFAULT_STYLES = {
    "glide": DEFAULT_PROMPT,
    "groove": (
        "A lively, energetic handheld camera move through a real party, travelling quickly from the "
        "first frame to the last frame with a rhythmic, bouncing feel, as if moving to the music. " + _KEEP
    ),
    "glow": (
        "A very slow, gentle, floating camera move through a real celebration, drifting from the "
        "first frame to the last frame and lingering on faces, soft and warm. " + _KEEP
    ),
}


# The AI is given a first and a last frame and a few seconds to get between them, so its words
# only change the look a little. The rest of a style is how we cut the clips together afterwards
# (walkthrough/media.py), which costs no AI seconds:
#   speed      over 1 plays the clips faster, under 1 slower
#   linger     seconds each clip rests on the photo it ends on
#   crossfade  seconds each clip dissolves into the next (0 = a straight cut). Unused for now:
#              a clip ends on the photo the next one starts from, so a dissolve there doesn't show.
#   warm       a warm colour tint
#   punch      a quick push in at the start of each clip
STYLE_EDITS = {
    "glide": {"speed": 1.0, "linger": 0.0, "crossfade": 0.0, "warm": False, "punch": False},
    "groove": {"speed": 1.25, "linger": 0.0, "crossfade": 0.0, "warm": False, "punch": True},
    "glow": {"speed": 0.8, "linger": 0.6, "crossfade": 0.0, "warm": True, "punch": False},
}


def style_edit(style_id: str | None) -> dict:
    """How a style is cut together. An unknown style gets Glide's plain cut."""
    return dict(STYLE_EDITS.get(style_id or DEFAULT_STYLE, STYLE_EDITS[DEFAULT_STYLE]))


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
    plans: tuple = tuple(dict(p) for p in DEFAULT_PLANS)
    checkout: bool = False  # Stripe Checkout for passes (walkthrough/billing.py); only a literal true
    prompt: str = DEFAULT_PROMPT
    styles: dict = field(default_factory=lambda: dict(DEFAULT_STYLES))
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

    def style_prompt(self, style_id: str | None) -> str | None:
        """The words sent to the AI for a style. No style means Glide. None when the style isn't one we have."""
        wanted = style_id or DEFAULT_STYLE
        return self.prompt if wanted == DEFAULT_STYLE else self.styles.get(wanted)

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

    # styles: { glide, groove, glow } can each be reworded. Glide falls back to the older `prompt`.
    styles_in = d.get("styles") if isinstance(d.get("styles"), dict) else {}
    styles = {k: (styles_in[k] if isinstance(styles_in.get(k), str) and styles_in[k].strip() else v)
              for k, v in DEFAULT_STYLES.items()}
    if not (isinstance(styles_in.get(DEFAULT_STYLE), str) and styles_in[DEFAULT_STYLE].strip()):
        if isinstance(d.get("prompt"), str) and d.get("prompt").strip():
            styles[DEFAULT_STYLE] = d["prompt"]

    plans_in = d.get("plans") if isinstance(d.get("plans"), dict) else {}
    plans = []
    for p in DEFAULT_PLANS:
        o = plans_in.get(p["id"]) if isinstance(plans_in.get(p["id"]), dict) else {}
        plans.append({**p, "usd": _number(o.get("usd"), p["usd"], 0), "seconds": _number(o.get("seconds"), p["seconds"], 0)})

    return Config(
        plans=tuple(plans),
        checkout=d.get("checkout") is True,
        styles=styles,
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
        prompt=styles[DEFAULT_STYLE],
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

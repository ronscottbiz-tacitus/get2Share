"""
Step In spending limits. Every moment is a paid GPU job, so the cloud job counts them and stops at
the caps below before it starts one. The app's own checks are only for showing the right button.

Firestore, written only by this code (no rule, so clients can't read or touch them):
  stepInUsage/event-{eid}          moments started for this event
  stepInUsage/host-{uid}-{month}   moments this host started this month (month = YYYY-MM, UTC)
  stepInUsage/global-{month}       moments and GPU warm-ups started this month, everyone together
  stepInUsage/warm-{eid}           when this event last warmed a GPU

Caps live in config/stepIn.limits (edited by an admin in the Firebase console):
  { perEvent: 20, perHostPerMonth: 60, perMonth: 500, warmsPerMonth: 600 }
A missing or bad value uses the default here. Admins skip the per-event and per-host caps, but
the monthly totals apply to everyone.

A moment is claimed in one transaction: the photo is marked queued and the counters go up
together, so two quick taps (or two co-hosts) can't start two jobs for one photo, and the caps
can't be passed by asking many times at once. A redo or a retry after a failure counts again,
since it runs the GPU again.
"""
from __future__ import annotations

from datetime import datetime, timezone

DEFAULT_LIMITS = {
    "perEvent": 20,
    "perHostPerMonth": 60,
    "perMonth": 500,       # about $65 at most: a moment is at most 10 GPU minutes on an L4
    "warmsPerMonth": 600,  # each warm-up can keep a GPU on for about 5 minutes
}
MAX_LIMIT = 100_000  # a sanity cap on what the config can ask for

GPU_TIMEOUT_SECONDS = 600  # StepIn's timeout in modal_app.py
# A job silent this long has died and can be asked for again. Longer than the GPU timeout, so a
# slow job that's still running is never started a second time.
STALE_SECONDS = GPU_TIMEOUT_SECONDS + 60
# The app asks to warm every 4 minutes while a host has it open; more often than this is ignored.
WARM_EVERY_SECONDS = 180

MSG_EVENT = "This event has made all the Step In moments it can ({n})."
MSG_HOST = "You've made all the Step In moments you can this month ({n}). It resets on the 1st."
MSG_MONTH = "Step In has reached its limit for this month. Try again on the 1st."
MSG_GONE = "That photo was deleted."


class LimitReached(Exception):
    """A cap was reached. The message is for the app to show."""


def parse_limits(config: dict | None) -> dict:
    raw = (config or {}).get("limits")
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for key, default in DEFAULT_LIMITS.items():
        v = raw.get(key)
        ok = isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= MAX_LIMIT
        out[key] = v if ok else default
    return out


def month_key(now: float) -> str:
    return datetime.fromtimestamp(now, tz=timezone.utc).strftime("%Y-%m")


def _seconds(v) -> float | None:
    """A Firestore timestamp (or a plain number in tests) as seconds since 1970."""
    if v is None:
        return None
    if hasattr(v, "timestamp"):
        return v.timestamp()
    return float(v) if isinstance(v, (int, float)) else None


def _dict(snap) -> dict:
    return (snap.to_dict() or {}) if snap.exists else {}


def _usage(db, key):
    return db.collection("stepInUsage").document(key)


def _safe_key(s: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in s)[:128]


def claim(db, run_tx, *, now: float, server_time, event_id: str, photo_id: str, uid: str,
          is_admin: bool, redo: bool, config: dict | None) -> tuple[bool, str]:
    """Marks the photo queued and counts the moment, if nothing is running for it and no cap is
    reached. Returns (True, "queued") when the caller should start the GPU job, or
    (False, current status) when there's nothing to start: it's already queued or processing, or
    ready and this isn't a redo. Raises LimitReached or FileNotFoundError."""
    limits = parse_limits(config)
    month = month_key(now)
    photo_ref = db.collection("events").document(event_id).collection("photos").document(photo_id)
    event_ref = _usage(db, f"event-{_safe_key(event_id)}")
    host_ref = _usage(db, f"host-{_safe_key(uid)}-{month}")
    global_ref = _usage(db, f"global-{month}")

    def tx_claim(tx):
        photo = photo_ref.get(transaction=tx)
        if not photo.exists:
            raise FileNotFoundError(MSG_GONE)
        ev, host, glob = (_dict(r.get(transaction=tx)) for r in (event_ref, host_ref, global_ref))

        current = (photo.to_dict() or {}).get("stepIn") or {}
        status = current.get("status")
        updated = _seconds(current.get("updatedAt"))
        stale = updated is None or now - updated > STALE_SECONDS
        if (status in ("queued", "processing") and not stale) or (status == "ready" and not redo):
            return False, status

        if glob.get("moments", 0) >= limits["perMonth"]:
            raise LimitReached(MSG_MONTH)
        if not is_admin:
            if ev.get("moments", 0) >= limits["perEvent"]:
                raise LimitReached(MSG_EVENT.format(n=limits["perEvent"]))
            if host.get("moments", 0) >= limits["perHostPerMonth"]:
                raise LimitReached(MSG_HOST.format(n=limits["perHostPerMonth"]))

        tx.update(photo_ref, {"stepIn": {
            "status": "queued", "requestedBy": uid,
            "requestedAt": server_time, "updatedAt": server_time,
        }})
        tx.set(event_ref, {**ev, "moments": ev.get("moments", 0) + 1})
        tx.set(host_ref, {**host, "moments": host.get("moments", 0) + 1})
        tx.set(global_ref, {**glob, "moments": glob.get("moments", 0) + 1})
        return True, "queued"

    return run_tx(tx_claim)


def may_warm(db, run_tx, *, now: float, event_id: str, config: dict | None) -> bool:
    """True when the caller should warm a GPU: this event hasn't warmed one in the last few
    minutes and the month's warm-ups aren't used up. Counts the warm-up when it says yes."""
    limits = parse_limits(config)
    month = month_key(now)
    warm_ref = _usage(db, f"warm-{_safe_key(event_id)}")
    global_ref = _usage(db, f"global-{month}")

    def tx_warm(tx):
        last = _dict(warm_ref.get(transaction=tx))
        glob = _dict(global_ref.get(transaction=tx))
        if now - float(last.get("at", 0)) < WARM_EVERY_SECONDS:
            return False
        if glob.get("warms", 0) >= limits["warmsPerMonth"]:
            return False
        tx.set(warm_ref, {"at": now})
        tx.set(global_ref, {**glob, "warms": glob.get("warms", 0) + 1})
        return True

    return run_tx(tx_warm)


def firestore_tx(db, fn):
    """Runs fn(transaction) in a real Firestore transaction, retried if another writer got there first."""
    from google.cloud import firestore

    @firestore.transactional
    def go(tx):
        return fn(tx)
    return go(db.transaction(max_attempts=10))

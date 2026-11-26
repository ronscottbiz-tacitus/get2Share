"""
The one-time launch change for plans (Free, Party, Big Event). Run it once, right after the
stack is merged and deployed and before the launch switch is flipped. See launch_app.py.

For every event that exists:
  - Paid already: an event with Flow seconds beyond what came with an upgrade (a Flow Pass, or
    seconds an admin gave) and no plan yet becomes a Big Event.
  - Free: the album moves from 30 days after the end to 14, but never closes sooner than 7 days
    after launch, and never later than it would have. So no host loses an album overnight.
  - Party or Big Event: the album runs its plan's length (never earlier than now).
  - The join code and each guest's "my events" entry get the new closing date.
  - Every record inside the event gets the later backstop date (closing + 365 days, as the app
    writes now), so an upgrade later can't be undone by Firestore's automatic deletion.

Events with no end time, events marked keep, and albums already past their date are left alone
(the nightly cleanup handles those). With live=False nothing is written; it only reports.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from walkthrough.billing import ALBUM_DAYS
from walkthrough.service import event_tier

OLD_ALBUM = timedelta(days=30)   # what the live app gives today
FREE_ALBUM = timedelta(days=14)  # what existing free events get at launch
GRACE = timedelta(days=7)        # no album closes sooner than this after launch
BACKSTOP = timedelta(days=365)   # same as TTL_EXTRA_MS in src/events.ts
MARK = ("config", "launch")      # written by a live run, so it isn't run twice by accident


@dataclass
class Report:
    events: int = 0
    made_big: list = field(default_factory=list)
    moved: list = field(default_factory=list)
    unchanged: int = 0
    skipped: list = field(default_factory=list)
    records: int = 0


def _ts(v):
    return v if isinstance(v, datetime) else None


def _day(d: datetime | None) -> str:
    return d.strftime("%b %d, %Y") if d else "none"


def new_closing(tier: str, ends: datetime, current: datetime | None, launch: datetime) -> datetime:
    """The album's closing date after launch."""
    current = current or ends + OLD_ALBUM  # the oldest events never had a date: 30 days, as the cleanup counts
    if tier == "free":
        return min(current, max(ends + FREE_ALBUM, launch + GRACE))
    return max(current, ends + timedelta(days=ALBUM_DAYS[tier]))


def run(db, *, live: bool, now: datetime | None = None, log=print, again: bool = False) -> Report:
    launch = now or datetime.now(timezone.utc)
    mark = db.collection(MARK[0]).document(MARK[1])
    done = mark.get()
    if done.exists:
        when = _ts((done.to_dict() or {}).get("ranAt"))
        log(f"The launch change already ran ({_day(when)}).")
        if live and not again:
            log("Not running it again. (Pass --again if you really mean to.)")
            return Report()

    r = Report()
    verb = "" if live else "would "
    for snap in db.collection("events").stream():
        r.events += 1
        eid, ev = snap.id, snap.to_dict() or {}
        name = ev.get("name") or eid
        ends = _ts(ev.get("endsAt"))
        current = _ts(ev.get("expireAt"))
        feat_ref = db.collection("features").document(eid)
        feat = feat_ref.get().to_dict() or {}
        if feat.get("keep"):
            r.skipped.append((eid, name, "marked keep"))
            continue
        if not ends:
            r.skipped.append((eid, name, "no end time"))
            continue
        if current and current <= launch:
            r.skipped.append((eid, name, "album already closed; the nightly cleanup removes it"))
            continue

        paid = (feat.get("flowSeconds") or 0) - (feat.get("includedSeconds") or 0)
        if event_tier(feat) == "free" and paid > 0:
            r.made_big.append((eid, name, paid))
            log(f"{name} ({eid}): {verb}become a Big Event ({paid:g} paid Flow seconds)")
            if live:
                feat_ref.set({"tier": "big", "upgraded": True, "upgradedAt": launch, "launchBig": True}, merge=True)
            feat = {**feat, "tier": "big", "upgraded": True}

        tier = event_tier(feat)
        closes = new_closing(tier, ends, current, launch)
        if closes == current:
            r.unchanged += 1
        else:
            r.moved.append((eid, name, tier, current, closes))
            log(f"{name} ({eid}, {tier}): album {verb}close {_day(closes)} (was {_day(current)})")
            if live:
                snap.reference.update({"expireAt": closes})
                code = ev.get("joinCode")
                if isinstance(code, str) and code:
                    code_ref = db.collection("joinCodes").document(code)
                    if code_ref.get().exists:
                        code_ref.update({"expireAt": closes})
                for member in snap.reference.collection("members").stream():
                    joined = db.collection("users").document(member.id).collection("joined").document(eid)
                    if joined.get().exists:
                        joined.update({"expireAt": closes})

        # The backstop on every record inside the event: never earlier than closing + 365 days.
        backstop = closes + BACKSTOP
        for col in snap.reference.collections():
            for doc in col.stream():
                at = _ts((doc.to_dict() or {}).get("expireAt"))
                if at and at < backstop:
                    r.records += 1
                    if live:
                        doc.reference.update({"expireAt": backstop})

    log("")
    log(f"{r.events} events: {len(r.made_big)} {verb}become Big Events, {len(r.moved)} albums {verb}move, "
        f"{r.unchanged} unchanged, {len(r.skipped)} left alone; {r.records} records {verb}get the later backstop date.")
    for eid, name, why in r.skipped:
        log(f"  left alone: {name} ({eid}): {why}")
    if live:
        mark.set({"ranAt": launch, "events": r.events, "madeBig": len(r.made_big), "moved": len(r.moved)})
        log("Done.")
    else:
        log("Nothing was changed. Run again with --live to make these changes.")
    return r

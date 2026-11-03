"""
Walkthrough jobs: the rules (who, how many, how much), and the cloud job that makes the video.

Firestore, all written only by this code:
  events/{eid}/walkthroughs/{wid}    what the app shows. Hosts read all; members only published.
  walkthroughJobs/{eid}__{wid}       the job's private state (lease, reservations, frame links)
  walkthroughUsage/event-{eid}       videos and redos counted for this event
  walkthroughUsage/host-{uid}-{m}    videos and redos counted for this host this month
  walkthroughUsage/global-{m}        dollars reserved and spent this month
The two walkthroughJobs and walkthroughUsage collections have no rule, so clients can't touch them.

Storage, under walkthroughs/{eid}/{wid}/: frames/ (cropped photos), clips/ (raw AI clips, kept
so a redo only pays for one clip), final-v{n}.mp4 and poster-v{n}.jpg. Only final and poster
have links the app sees. Raw clips have no label, so their links never leave the job.

Money: each clip attempt reserves its price in a transaction before anything is sent. When it
ends, the reservation becomes "spent" (a finished clip, or an outcome we can't know, because the
cap must err on the safe side) or "released" (the provider said no, or nothing was sent).

Crash safety: a job holds a lease, renewed while it works. If the worker dies the lease runs out,
and the sweep starts the job again. It picks up where it stopped: finished clips are skipped, and
a clip already at the provider is polled, not paid for twice.
"""
from __future__ import annotations

import hashlib
import tempfile
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import media
from .config import ASPECTS, LABEL, NOTICE_VERSION, Config, month_key, parse_config, size_for
from .providers import (
    ClipRequest, ContentRejected, GenerationFailed, Provider, ProviderError, ProviderFailed, ProviderNotReady,
    TransientProviderError, selected_name,
)

JOBS = "walkthroughJobs"
USAGE = "walkthroughUsage"
LEASE_SECONDS = 300            # no heartbeat for this long: the worker is treated as dead
HEARTBEAT_SECONDS = 60
POLL_SECONDS = 10
POLL_TIMEOUT_SECONDS = 15 * 60  # one clip at the provider
MAX_ATTEMPTS = 2               # the first try plus one automatic retry
MAX_RUNS = 6                   # restarts of one job before it is called failed
DOWNLOAD_TRIES = 3
BUSY = ("queued", "generating", "joining")

MSG_BLOCKED = ("The AI service wouldn't animate these photos, often because of faces or its content "
               "rules. This didn't use up your limit. Try different photos.")
MSG_BLOCKED_REDO = ("The AI service wouldn't redo this clip, often because of faces or its content rules. "
                    "Your video is unchanged and this redo wasn't counted.")
MSG_FAILED = "The video didn't finish. This didn't use up your limit. Try again in a few minutes."
MSG_FAILED_REDO = "That redo didn't finish. Your video is unchanged and this redo wasn't counted."
MSG_BUDGET = "Walkthrough videos have reached this month's budget. Try again next month."
MSG_OFF = "Walkthrough videos are turned off right now."
MSG_PHOTO_GONE = "One of these photos was deleted. Pick different photos."


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Cancelled(Exception):
    """The video was deleted while the job was working on it."""


class LeaseLost(Exception):
    """Another worker took over this job."""


class BudgetExceeded(Exception):
    pass


class ClipOutcomeUnknown(Exception):
    """We can't tell what happened at the provider, or whether it charged."""


@dataclass
class Deps:
    db: Any
    run_tx: Callable                # run_tx(fn) calls fn(transaction), retrying as Firestore does
    storage: Any                    # upload, download, exists, delete_prefix, rotate
    load_photo: Callable            # load_photo(eid, photo_id) -> PIL image
    provider_for: Callable          # provider_for(name, model) -> Provider
    spawn: Callable                 # spawn(eid, wid): start the job in the background
    server_time: Any = None         # firestore.SERVER_TIMESTAMP
    now: Callable = time.time
    sleep: Callable = time.sleep
    env: dict = field(default_factory=dict)
    poll_seconds: float = POLL_SECONDS
    poll_timeout: float = POLL_TIMEOUT_SECONDS
    log: Callable = print


def _dict(snap) -> dict:
    return (snap.to_dict() or {}) if snap.exists else {}


def _money(x: float) -> float:
    return round(float(x), 4)


def res_key(index: int, clip: dict) -> str:
    return f"{index}-{clip.get('gen', 1)}-{clip.get('attempt', 1)}"


class Service:
    def __init__(self, deps: Deps):
        self.d = deps
        self.db = deps.db

    # -------------------------------------------------------------- references
    def wt_ref(self, eid, wid):
        return self.db.collection("events").document(eid).collection("walkthroughs").document(wid)

    def job_ref(self, eid, wid):
        return self.db.collection(JOBS).document(f"{eid}__{wid}")

    def usage_ref(self, key):
        return self.db.collection(USAGE).document(key)

    def config(self) -> Config:
        return parse_config(_dict(self.db.collection("config").document("walkthrough").get()))

    # -------------------------------------------------------------- who can make videos
    def _require_access(self, cfg: Config, is_admin: bool) -> None:
        if not cfg.enabled:
            raise ApiError(403, MSG_OFF)
        if not (is_admin or cfg.all_hosts):
            raise ApiError(403, "Walkthrough videos aren't open to all hosts yet.")

    def _photo_ok(self, eid: str, photo_id: str) -> bool:
        snap = self.db.collection("events").document(eid).collection("photos").document(photo_id).get()
        return snap.exists and (snap.to_dict() or {}).get("status") == "approved"

    # -------------------------------------------------------------- POST /create
    def create(self, *, uid: str, is_admin: bool, eid: str, event: dict, photo_ids: list[str], preset_id: str | None,
               aspect: str, accepted_notice: bool, notice_version: int, request_id: str) -> dict:
        cfg = self.config()
        self._require_access(cfg, is_admin)
        if accepted_notice is not True or notice_version != NOTICE_VERSION:
            raise ApiError(400, "Accept the notice about the outside AI service first.")
        if aspect not in ASPECTS:
            raise ApiError(400, "Pick vertical or horizontal.")
        preset = cfg.preset(preset_id)
        if preset is None:
            raise ApiError(400, "That video length isn't available.")
        if len(photo_ids) != preset.photos or len(set(photo_ids)) != preset.photos:
            raise ApiError(400, f"Pick exactly {preset.photos} different photos.")
        if not request_id or len(request_id) > 80:
            raise ApiError(400, "Missing request ID.")
        expire = event.get("expireAt")
        if expire is not None and hasattr(expire, "timestamp") and expire.timestamp() < self.d.now():
            raise ApiError(409, "This event's album has closed.")
        for photo_id in photo_ids:
            if not self._photo_ok(eid, photo_id):
                raise ApiError(409, "One of these photos was deleted or isn't approved. Pick different photos.")

        provider = selected_name(cfg.provider, self.d.env)
        if not provider:
            raise ApiError(503, "Walkthrough videos aren't set up yet: no video service is chosen.")
        try:
            self.d.provider_for(provider, cfg.model)  # catches a missing key before anything is counted
        except ProviderNotReady as e:
            self.d.log(f"Walkthrough provider not ready: {e}")
            raise ApiError(503, "Walkthrough videos aren't set up yet: the video service isn't ready.")
        per_second = cfg.price_per_second(provider, cfg.resolution)
        if per_second is None:
            raise ApiError(503, "Walkthrough videos aren't set up yet: no price is set for this video service.")

        clip_usd = _money(per_second * preset.clip_seconds)
        wid = hashlib.sha1(f"{eid}:{request_id}".encode()).hexdigest()[:20]  # a double tap makes one video
        now = self.d.now()
        month = month_key(now)
        clips = [{
            "index": i,
            "startPhotoId": photo_ids[i],
            "endPhotoId": photo_ids[i + 1],
            "status": "pending",
            "gen": 1,
            "attempt": 1,
            "slowdown": cfg.slowdown_for(i),
        } for i in range(preset.clips)]
        seconds = (sum(preset.clip_seconds * c["slowdown"] for c in clips) + cfg.hold_start + cfg.hold_end)
        doc = {
            "status": "queued",
            "photoIds": photo_ids,
            "presetId": preset.id,
            "aspect": aspect,
            "resolution": cfg.resolution,
            "clipSeconds": preset.clip_seconds,
            "seconds": seconds,
            "clips": clips,
            "label": LABEL,
            "provider": provider,
            "redosUsed": 0,
            "videoVersion": 0,
            "videoUrl": None,
            "posterUrl": None,
            "error": None,
            "errorKind": None,
            "redoNotice": None,
            "createdBy": uid,
            "createdAt": self.d.server_time,
            "updatedAt": self.d.server_time,
            "noticeAcceptedBy": uid,
            "noticeAcceptedAt": self.d.server_time,
            "noticeVersion": NOTICE_VERSION,
        }
        job = {
            "eventId": eid,
            "walkthroughId": wid,
            "active": True,
            "mode": "create",
            "chargedHost": uid,
            "chargedMonth": month,
            "countsVideo": True,
            "provider": provider,
            "model": cfg.model,
            "prompt": cfg.prompt,
            "clipUsd": clip_usd,
            "holdStart": cfg.hold_start,
            "holdEnd": cfg.hold_end,
            "holdZoom": cfg.hold_zoom,
            "reservations": {res_key(c["index"], c): {"usd": clip_usd, "state": "reserved", "month": month} for c in clips},
            "frameUrls": {},
            "leaseOwner": None,
            "leaseUntil": now + 60,  # gives the spawned worker first claim, before any sweep
            "runs": 0,
        }
        total = _money(clip_usd * len(clips))

        def tx_create(tx):
            wt = self.wt_ref(eid, wid)
            existing = wt.get(transaction=tx)
            if existing.exists:
                return existing.to_dict().get("status"), False
            event_ref, host_ref, global_ref = (self.usage_ref(f"event-{eid}"), self.usage_ref(f"host-{uid}-{month}"),
                                               self.usage_ref(f"global-{month}"))
            ev_use = _dict(event_ref.get(transaction=tx))
            host_use = _dict(host_ref.get(transaction=tx))
            glob = _dict(global_ref.get(transaction=tx))
            if ev_use.get("activeJob"):
                raise ApiError(409, "A video for this event is already being made.")
            if ev_use.get("videos", 0) >= cfg.limits["videosPerEvent"]:
                raise ApiError(429, "This event has already used its Walkthrough video.")
            if host_use.get("videos", 0) >= cfg.limits["videosPerHostPerMonth"]:
                raise ApiError(429, "You've used all your Walkthrough videos for this month.")
            if _money(glob.get("reservedUsd", 0) + glob.get("spentUsd", 0) + total) > cfg.monthly_budget_usd:
                raise ApiError(429, MSG_BUDGET)
            tx.set(wt, doc)
            tx.set(self.job_ref(eid, wid), job)
            tx.set(event_ref, {**ev_use, "videos": ev_use.get("videos", 0) + 1, "activeJob": wid})
            tx.set(host_ref, {**host_use, "videos": host_use.get("videos", 0) + 1})
            tx.set(global_ref, {**glob, "reservedUsd": _money(glob.get("reservedUsd", 0) + total)})
            return "queued", True

        status, created = self.d.run_tx(tx_create)
        if created:
            self._spawn(eid, wid)
        return {"id": wid, "status": status}

    def _spawn(self, eid, wid):
        try:
            self.d.spawn(eid, wid)
        except Exception as e:  # the job is saved; the sweep will start it
            self.d.log(f"Walkthrough spawn failed for {eid}/{wid}: {e}")

    # -------------------------------------------------------------- POST /redo
    def redo(self, *, uid: str, is_admin: bool, eid: str, wid: str, clip_index: int) -> dict:
        """Regenerate one clip of a finished preview. On a video that failed, this is "try again":
        it fills in the missing clips, with the finished ones kept, and uses no redo."""
        cfg = self.config()
        self._require_access(cfg, is_admin)
        snap = self.wt_ref(eid, wid).get()
        if not snap.exists:
            raise ApiError(404, "That video was deleted.")
        current = snap.to_dict()
        clips = current.get("clips") or []
        if not (0 <= clip_index < len(clips)):
            raise ApiError(400, "That clip doesn't exist.")
        for photo_id in (clips[clip_index]["startPhotoId"], clips[clip_index]["endPhotoId"]):
            if not self._photo_ok(eid, photo_id):
                raise ApiError(409, MSG_PHOTO_GONE)
        now = self.d.now()
        month = month_key(now)

        def tx_redo(tx):
            wt_ref, job_ref = self.wt_ref(eid, wid), self.job_ref(eid, wid)
            wt_snap = wt_ref.get(transaction=tx)
            if not wt_snap.exists:
                raise ApiError(404, "That video was deleted.")
            wt, job = wt_snap.to_dict(), _dict(job_ref.get(transaction=tx))
            status = wt.get("status")
            if status in BUSY:
                raise ApiError(409, "This video is still being worked on.")
            if status == "blocked":
                raise ApiError(409, "The AI service refused these photos, so trying them again won't help. Pick different photos.")
            if status == "published":
                raise ApiError(409, "Take this video down before changing it.")
            if status not in ("preview", "failed"):
                raise ApiError(409, "This video can't be changed right now.")
            event_ref, host_ref, global_ref = (self.usage_ref(f"event-{eid}"), self.usage_ref(f"host-{uid}-{month}"),
                                               self.usage_ref(f"global-{month}"))
            ev_use, host_use, glob = (_dict(event_ref.get(transaction=tx)), _dict(host_ref.get(transaction=tx)),
                                      _dict(global_ref.get(transaction=tx)))
            if ev_use.get("activeJob"):
                raise ApiError(409, "A video for this event is already being made.")
            clips = wt["clips"]
            reservations = dict(job.get("reservations") or {})
            clip_usd = job.get("clipUsd", 0)

            if status == "preview":
                if ev_use.get("redos", 0) >= cfg.limits["redosPerEvent"]:
                    raise ApiError(429, "This event has used all its redos.")
                if host_use.get("redos", 0) >= cfg.limits["redosPerHostPerMonth"]:
                    raise ApiError(429, "You've used all your redos for this month.")
                todo = [clip_index]
                new_job = {"mode": "redo", "redoClip": clip_index, "countsVideo": False, "countsRedo": True}
                host_use["redos"] = host_use.get("redos", 0) + 1
                ev_use["redos"] = ev_use.get("redos", 0) + 1
                wt["redosUsed"] = wt.get("redosUsed", 0) + 1
            else:  # failed: try again, counted like a new video until it fails again
                if ev_use.get("videos", 0) >= cfg.limits["videosPerEvent"]:
                    raise ApiError(429, "This event has already used its Walkthrough video.")
                if host_use.get("videos", 0) >= cfg.limits["videosPerHostPerMonth"]:
                    raise ApiError(429, "You've used all your Walkthrough videos for this month.")
                todo = [c["index"] for c in clips if c.get("status") != "ready"]
                new_job = {"mode": "create", "redoClip": None, "countsVideo": True, "countsRedo": False}
                host_use["videos"] = host_use.get("videos", 0) + 1
                ev_use["videos"] = ev_use.get("videos", 0) + 1

            total = _money(clip_usd * len(todo))
            if _money(glob.get("reservedUsd", 0) + glob.get("spentUsd", 0) + total) > cfg.monthly_budget_usd:
                raise ApiError(429, MSG_BUDGET)
            for i in todo:
                clip = clips[i]
                clip.update(status="pending", gen=clip.get("gen", 1) + 1, attempt=1, providerRef=None, error=None)
                reservations[res_key(i, clip)] = {"usd": clip_usd, "state": "reserved", "month": month}
            tx.update(wt_ref, {"clips": clips, "status": "queued", "error": None, "errorKind": None, "redoNotice": None,
                               "redosUsed": wt.get("redosUsed", 0), "updatedAt": self.d.server_time})
            tx.update(job_ref, {**new_job, "active": True, "reservations": reservations, "chargedHost": uid,
                                "chargedMonth": month, "leaseOwner": None, "leaseUntil": now + 60, "runs": 0})
            tx.set(event_ref, {**ev_use, "activeJob": wid})
            tx.set(host_ref, host_use)
            tx.set(global_ref, {**glob, "reservedUsd": _money(glob.get("reservedUsd", 0) + total)})

        self.d.run_tx(tx_redo)
        self._spawn(eid, wid)
        return {"id": wid, "status": "queued"}

    # -------------------------------------------------------------- POST /approve
    def approve(self, *, uid: str, eid: str, wid: str) -> dict:
        def tx_approve(tx):
            ref = self.wt_ref(eid, wid)
            snap = ref.get(transaction=tx)
            if not snap.exists:
                raise ApiError(404, "That video was deleted.")
            wt = snap.to_dict()
            if wt.get("status") == "published":
                return
            if wt.get("status") != "preview" or not wt.get("videoUrl"):
                raise ApiError(409, "This video isn't ready to approve.")
            tx.update(ref, {"status": "published", "publishedBy": uid, "publishedAt": self.d.server_time,
                            "redoNotice": None, "updatedAt": self.d.server_time})
        self.d.run_tx(tx_approve)
        return {"id": wid, "status": "published"}

    # -------------------------------------------------------------- POST /unpublish
    def unpublish(self, *, eid: str, wid: str) -> dict:
        """Back to host-only. The file gets a new link, so links guests already had stop working."""
        def tx_unpublish(tx):
            ref = self.wt_ref(eid, wid)
            snap = ref.get(transaction=tx)
            if not snap.exists:
                raise ApiError(404, "That video was deleted.")
            wt = snap.to_dict()
            if wt.get("status") not in ("published", "preview"):
                raise ApiError(409, "This video isn't published.")
            tx.update(ref, {"status": "preview", "publishedAt": None, "publishedBy": None, "updatedAt": self.d.server_time})
            return wt

        wt = self.d.run_tx(tx_unpublish)
        fresh = {}
        if wt.get("videoPath"):
            fresh["videoUrl"] = self.d.storage.rotate(wt["videoPath"])
        if wt.get("posterPath"):
            fresh["posterUrl"] = self.d.storage.rotate(wt["posterPath"])
        if fresh:
            self.wt_ref(eid, wid).update(fresh)
        return {"id": wid, "status": "preview"}

    # -------------------------------------------------------------- POST /delete
    def delete(self, *, eid: str, wid: str) -> dict:
        """Removes the video and its files for good. A video that was made still counts: otherwise
        making and deleting would get around the limits. A running job stops at its next check."""
        def tx_delete(tx):
            ref, job_ref = self.wt_ref(eid, wid), self.job_ref(eid, wid)
            snap = ref.get(transaction=tx)
            wt, job = _dict(snap), _dict(job_ref.get(transaction=tx))
            if not snap.exists and not job:
                return
            reads = self._settle_all_reads(tx, wt, job)
            event_ref = self.usage_ref(f"event-{eid}")
            ev_use = _dict(event_ref.get(transaction=tx))
            self._settle_all_writes(tx, job, wt, reads)
            if ev_use.get("activeJob") == wid:
                tx.set(event_ref, {**ev_use, "activeJob": None})
            if job:
                tx.update(job_ref, {"active": False, "deleted": True, "frameUrls": {},
                                    "reservations": job.get("reservations") or {}})
            if snap.exists:
                tx.delete(ref)

        self.d.run_tx(tx_delete)
        self.d.storage.delete_prefix(f"walkthroughs/{eid}/{wid}/")
        return {"id": wid, "status": "deleted"}

    # -------------------------------------------------------------- reservations
    def _reserve(self, eid, wid, key: str) -> None:
        """Make sure this attempt has money set aside. An attempt reserved earlier stays as is."""
        def tx_reserve(tx):
            job_ref = self.job_ref(eid, wid)
            job = _dict(job_ref.get(transaction=tx))
            reservations = dict(job.get("reservations") or {})
            if key in reservations:
                return
            month = month_key(self.d.now())
            global_ref = self.usage_ref(f"global-{month}")
            glob = _dict(global_ref.get(transaction=tx))
            usd = job.get("clipUsd", 0)
            cap = self.config_in_tx(tx).monthly_budget_usd
            if _money(glob.get("reservedUsd", 0) + glob.get("spentUsd", 0) + usd) > cap:
                raise BudgetExceeded()
            reservations[key] = {"usd": usd, "state": "reserved", "month": month}
            tx.update(job_ref, {"reservations": reservations})
            tx.set(global_ref, {**glob, "reservedUsd": _money(glob.get("reservedUsd", 0) + usd)})
        self.d.run_tx(tx_reserve)

    def config_in_tx(self, tx) -> Config:
        return parse_config(_dict(self.db.collection("config").document("walkthrough").get(transaction=tx)))

    def _settle(self, eid, wid, key: str, outcome: str) -> None:
        """outcome: spent or released. Only the first settle of a reservation counts."""
        def tx_settle(tx):
            job_ref = self.job_ref(eid, wid)
            job = _dict(job_ref.get(transaction=tx))
            reservations = dict(job.get("reservations") or {})
            res = reservations.get(key)
            if not res or res.get("state") != "reserved":
                return
            global_ref = self.usage_ref(f"global-{res['month']}")
            glob = _dict(global_ref.get(transaction=tx))
            res = {**res, "state": outcome}
            reservations[key] = res
            fresh = {**glob, "reservedUsd": _money(max(0, glob.get("reservedUsd", 0) - res["usd"]))}
            if outcome == "spent":
                fresh["spentUsd"] = _money(glob.get("spentUsd", 0) + res["usd"])
            tx.update(job_ref, {"reservations": reservations})
            tx.set(global_ref, fresh)
        self.d.run_tx(tx_settle)

    def _settle_all_reads(self, tx, wt: dict, job: dict) -> dict:
        months = {r["month"] for r in (job.get("reservations") or {}).values() if r.get("state") == "reserved"}
        return {m: _dict(self.usage_ref(f"global-{m}").get(transaction=tx)) for m in months}

    def _settle_all_writes(self, tx, job: dict, wt: dict, globals_by_month: dict) -> None:
        """Close every open reservation. A clip that may be at the provider counts as spent,
        since we can't know what it will cost us; anything never sent is released."""
        in_flight = {res_key(c["index"], c) for c in wt.get("clips") or [] if c.get("status") in ("submitting", "submitted")}
        reservations = job.get("reservations") or {}
        for key, res in reservations.items():
            if res.get("state") != "reserved":
                continue
            glob = globals_by_month[res["month"]]
            glob["reservedUsd"] = _money(max(0, glob.get("reservedUsd", 0) - res["usd"]))
            if key in in_flight:
                glob["spentUsd"] = _money(glob.get("spentUsd", 0) + res["usd"])
                res["state"] = "spent"
            else:
                res["state"] = "released"
        for month, glob in globals_by_month.items():
            tx.set(self.usage_ref(f"global-{month}"), glob)

    # -------------------------------------------------------------- the lease
    def _claim(self, eid, wid, me: str) -> str:
        now = self.d.now()

        def tx_claim(tx):
            ref = self.job_ref(eid, wid)
            snap = ref.get(transaction=tx)
            if not snap.exists or not snap.to_dict().get("active"):
                return "inactive"
            job = snap.to_dict()
            if job.get("leaseOwner") and job.get("leaseUntil", 0) > now:
                return "busy"
            runs = job.get("runs", 0) + 1
            tx.update(ref, {"leaseOwner": me, "leaseUntil": now + LEASE_SECONDS, "runs": runs})
            return "too-many" if runs > MAX_RUNS else "ok"
        return self.d.run_tx(tx_claim)

    def _heartbeat(self, eid, wid, me: str) -> None:
        now = self.d.now()

        def tx_beat(tx):
            ref = self.job_ref(eid, wid)
            job = _dict(ref.get(transaction=tx))
            if job.get("leaseOwner") != me:
                raise LeaseLost()
            tx.update(ref, {"leaseUntil": now + LEASE_SECONDS})
        self.d.run_tx(tx_beat)
        if self.wt_ref(eid, wid).get().exists:
            self.wt_ref(eid, wid).update({"updatedAt": self.d.server_time})
        else:
            raise Cancelled()

    def _release_lease(self, eid, wid, me: str) -> None:
        def tx_release(tx):
            ref = self.job_ref(eid, wid)
            snap = ref.get(transaction=tx)
            if snap.exists and snap.to_dict().get("leaseOwner") == me:
                tx.update(ref, {"leaseOwner": None, "leaseUntil": 0})
        self.d.run_tx(tx_release)

    # -------------------------------------------------------------- doc helpers
    def _read(self, eid, wid) -> dict:
        snap = self.wt_ref(eid, wid).get()
        if not snap.exists:
            raise Cancelled()
        return snap.to_dict()

    def _set_status(self, eid, wid, **fields) -> None:
        def tx_status(tx):
            ref = self.wt_ref(eid, wid)
            if not ref.get(transaction=tx).exists:
                raise Cancelled()
            tx.update(ref, {**fields, "updatedAt": self.d.server_time})
        self.d.run_tx(tx_status)

    def _update_clip(self, eid, wid, index: int, **fields) -> dict:
        def tx_clip(tx):
            ref = self.wt_ref(eid, wid)
            snap = ref.get(transaction=tx)
            if not snap.exists:
                raise Cancelled()
            clips = snap.to_dict()["clips"]
            clips[index].update(fields)
            tx.update(ref, {"clips": clips, "updatedAt": self.d.server_time})
            return clips[index]
        return self.d.run_tx(tx_clip)

    # -------------------------------------------------------------- ending a job
    def _finish(self, eid, wid, *, ok: bool, kind: str | None = None, message: str | None = None) -> None:
        """Ends the job in one transaction: closes reservations, gives back the allowance if the
        host didn't get what they asked for, and sets what the app shows."""
        def tx_finish(tx):
            wt_ref, job_ref = self.wt_ref(eid, wid), self.job_ref(eid, wid)
            wt_snap = wt_ref.get(transaction=tx)
            job = _dict(job_ref.get(transaction=tx))
            if not wt_snap.exists or not job.get("active"):
                return
            wt = wt_snap.to_dict()
            event_ref = self.usage_ref(f"event-{eid}")
            host_ref = self.usage_ref(f"host-{job.get('chargedHost')}-{job.get('chargedMonth')}")
            ev_use, host_use = _dict(event_ref.get(transaction=tx)), _dict(host_ref.get(transaction=tx))
            globals_by_month = self._settle_all_reads(tx, wt, job)

            self._settle_all_writes(tx, job, wt, globals_by_month)
            is_redo = job.get("mode") == "redo"
            patch: dict = {"updatedAt": self.d.server_time}
            if not ok:
                if is_redo:
                    # Keep the video the host already has, and the good clip it was made from.
                    clips = wt["clips"]
                    clip = clips[job["redoClip"]]
                    clip.update(status="ready" if clip.get("storagePath") else "failed", providerRef=None)
                    patch.update(status="preview", clips=clips, redoNotice=message,
                                 redosUsed=max(0, wt.get("redosUsed", 0) - 1))
                    ev_use["redos"] = max(0, ev_use.get("redos", 0) - 1)
                    host_use["redos"] = max(0, host_use.get("redos", 0) - 1)
                else:
                    patch.update(status=kind, error=message, errorKind=kind)
                    ev_use["videos"] = max(0, ev_use.get("videos", 0) - 1)
                    host_use["videos"] = max(0, host_use.get("videos", 0) - 1)
            tx.update(wt_ref, patch)
            tx.update(job_ref, {"active": False, "leaseOwner": None, "leaseUntil": 0,
                                "reservations": job.get("reservations") or {}})
            tx.set(event_ref, {**ev_use, "activeJob": None})
            tx.set(host_ref, host_use)
        self.d.run_tx(tx_finish)

    # -------------------------------------------------------------- the cloud job
    def run(self, eid: str, wid: str) -> str:
        """Safe to call any number of times, from anywhere: only one worker can hold the lease,
        and finished work is never redone."""
        me = uuid.uuid4().hex
        claim = self._claim(eid, wid, me)
        if claim == "too-many":
            self._finish(eid, wid, ok=False, kind="failed", message=MSG_FAILED)
            return "failed"
        if claim != "ok":
            return claim
        try:
            with tempfile.TemporaryDirectory() as td:
                return self._run(eid, wid, me, Path(td))
        except Cancelled:
            self.d.storage.delete_prefix(f"walkthroughs/{eid}/{wid}/")
            return "cancelled"
        except LeaseLost:
            return "lease-lost"
        except Exception as e:
            self.d.log(f"Walkthrough {eid}/{wid} failed: {e}\n{traceback.format_exc()}")
            self._finish(eid, wid, ok=False, kind="failed", message=self._failed_msg(eid, wid))
            return "failed"
        finally:
            self._release_lease(eid, wid, me)

    def _failed_msg(self, eid, wid) -> str:
        job = _dict(self.job_ref(eid, wid).get())
        return MSG_FAILED_REDO if job.get("mode") == "redo" else MSG_FAILED

    def _run(self, eid, wid, me: str, tmp: Path) -> str:
        wt = self._read(eid, wid)
        job = _dict(self.job_ref(eid, wid).get())
        is_redo = job.get("mode") == "redo"
        try:
            provider = self.d.provider_for(job["provider"], job.get("model"))
        except ProviderError as e:
            self.d.log(f"Walkthrough provider not ready: {e}")
            self._finish(eid, wid, ok=False, kind="failed", message=self._failed_msg(eid, wid))
            return "failed"

        todo = [c["index"] for c in wt["clips"] if c.get("status") != "ready"]
        self._set_status(eid, wid, status="generating")
        try:
            frames = self._frames(eid, wid, wt, job, tmp, todo)
        except FileNotFoundError:
            self._finish(eid, wid, ok=False, kind="failed", message=MSG_PHOTO_GONE)
            return "failed"

        for index in todo:
            outcome, message = self._do_clip(eid, wid, me, index, provider, frames, wt, tmp)
            if outcome == "blocked":
                self._finish(eid, wid, ok=False, kind="blocked", message=MSG_BLOCKED_REDO if is_redo else MSG_BLOCKED)
                return "blocked"
            if outcome != "ready":
                final = message or (MSG_FAILED_REDO if is_redo else MSG_FAILED)
                self._finish(eid, wid, ok=False, kind="failed", message=final)
                return "failed"

        self._heartbeat(eid, wid, me)
        self._set_status(eid, wid, status="joining")
        self._join(eid, wid, job, frames, tmp)
        self._finish(eid, wid, ok=True)
        return "preview"

    # -------------------------------------------------------------- frames
    def _frames(self, eid, wid, wt, job, tmp: Path, todo: list[int]) -> dict:
        """Crop every photo once, up front, so a deleted photo stops the job before any money is
        spent. Cropped frames are kept, so the join's hold segments and redos can reuse them."""
        frames: dict[int, dict] = {}
        urls = dict(job.get("frameUrls") or {})
        changed = False
        for i, photo_id in enumerate(wt["photoIds"]):
            local = tmp / f"frame-{i}.jpg"
            remote = f"walkthroughs/{eid}/{wid}/frames/{i}.jpg"
            url = urls.get(str(i))
            if url and self.d.storage.exists(remote):
                self.d.storage.download(remote, str(local))
            else:
                img = self.d.load_photo(eid, photo_id)
                media.normalize_frame(img, wt["aspect"], wt["resolution"], str(local))
                url = self.d.storage.upload(str(local), remote, "image/jpeg")
                urls[str(i)] = url
                changed = True
            frames[i] = {"path": str(local), "url": url}
        if changed:
            self.job_ref(eid, wid).update({"frameUrls": urls})
        return frames

    # -------------------------------------------------------------- one clip
    def _retry_or_fail(self, eid, wid, index: int, clip: dict, reason: str) -> tuple[str, str | None] | None:
        """The one automatic retry. Returns None to go around again, or the clip's final outcome."""
        self.d.log(f"Walkthrough {eid}/{wid} clip {index}: {reason}")
        if clip.get("attempt", 1) >= MAX_ATTEMPTS:
            self._update_clip(eid, wid, index, status="failed", providerRef=None, error=reason[:200])
            return "failed", None
        self._update_clip(eid, wid, index, status="pending", providerRef=None, attempt=clip.get("attempt", 1) + 1)
        return None

    def _do_clip(self, eid, wid, me: str, index: int, provider: Provider, frames, wt, tmp: Path) -> tuple[str, str | None]:
        while True:
            self._heartbeat(eid, wid, me)
            clip = self._read(eid, wid)["clips"][index]
            status = clip.get("status")
            key = res_key(index, clip)

            if status == "ready":
                return "ready", None

            if status == "submitting":
                # A worker died mid-send, so this may be running and billing at the provider.
                self._settle(eid, wid, key, "spent")
                final = self._retry_or_fail(eid, wid, index, clip, "worker stopped while sending")
                if final:
                    return final
                continue

            if status == "pending":
                if not self.config().enabled:
                    self._settle(eid, wid, key, "released")
                    self._update_clip(eid, wid, index, status="failed", error="off")
                    return "failed", MSG_OFF
                try:
                    self._reserve(eid, wid, key)
                except BudgetExceeded:
                    self._update_clip(eid, wid, index, status="failed", error="budget")
                    return "failed", MSG_BUDGET
                self._update_clip(eid, wid, index, status="submitting")
                try:
                    ref = provider.submit(self._request(wid, index, clip, frames, wt, self.job_ref(eid, wid)))
                except ContentRejected as e:
                    self._settle(eid, wid, key, "released")
                    self._update_clip(eid, wid, index, status="blocked", error=str(e)[:200])
                    return "blocked", None
                except TransientProviderError as e:
                    self._settle(eid, wid, key, "released")
                    final = self._retry_or_fail(eid, wid, index, clip, str(e))
                    if final:
                        return final
                    self.d.sleep(self.d.poll_seconds)
                    continue
                except ProviderFailed as e:  # our request was wrong or the key is bad; a retry won't help
                    self._settle(eid, wid, key, "released")
                    self.d.log(f"Walkthrough {eid}/{wid} clip {index}: {e}")
                    self._update_clip(eid, wid, index, status="failed", providerRef=None, error=str(e)[:200])
                    return "failed", None
                self._update_clip(eid, wid, index, status="submitted", providerRef=ref)
                continue

            if status == "submitted":
                try:
                    url = self._wait(eid, wid, me, provider, clip["providerRef"])
                    self._download_clip(eid, wid, index, clip, provider, url, tmp)
                    self._settle(eid, wid, key, "spent")
                except ContentRejected as e:
                    self._settle(eid, wid, key, "released")
                    self._update_clip(eid, wid, index, status="blocked", providerRef=None, error=str(e)[:200])
                    return "blocked", None
                except GenerationFailed as e:        # it said it failed: providers don't bill those
                    self._settle(eid, wid, key, "released")
                    final = self._retry_or_fail(eid, wid, index, clip, str(e))
                    if final:
                        return final
                except ClipOutcomeUnknown as e:      # may have been billed
                    self._settle(eid, wid, key, "spent")
                    final = self._retry_or_fail(eid, wid, index, clip, str(e))
                    if final:
                        return final
                continue

            # failed, blocked: a restarted worker finds it already decided
            return ("blocked" if status == "blocked" else "failed"), None

    def _request(self, wid, index, clip, frames, wt, job_ref) -> ClipRequest:
        job = _dict(job_ref.get())
        start, end = frames[index], frames[index + 1]
        return ClipRequest(
            key=f"{wid}-{res_key(index, clip)}",
            start_url=start["url"], end_url=end["url"], start_path=start["path"], end_path=end["path"],
            seconds=wt["clipSeconds"], resolution=wt["resolution"], aspect=wt["aspect"],
            prompt=job.get("prompt") or "", generate_audio=False,
        )

    def _wait(self, eid, wid, me, provider: Provider, ref: str) -> str:
        """Poll until the clip is done. Network trouble while polling just means poll again."""
        deadline = self.d.now() + self.d.poll_timeout
        last_beat = self.d.now()
        while True:
            try:
                status = provider.check(ref)
                if status.done:
                    return status.url
            except TransientProviderError as e:  # no real answer came back, so ask again
                self.d.log(f"Walkthrough poll: {e}")
            now = self.d.now()
            if now > deadline:
                raise ClipOutcomeUnknown("timed out waiting for the provider")
            if now - last_beat >= HEARTBEAT_SECONDS:
                self._heartbeat(eid, wid, me)
                last_beat = now
            self.d.sleep(self.d.poll_seconds)

    def _download_clip(self, eid, wid, index, clip, provider: Provider, url: str, tmp: Path) -> None:
        """Provider links expire, so the clip goes to our Storage straight away."""
        local = tmp / f"raw-{index}-{clip.get('gen', 1)}.mp4"
        last = None
        for attempt in range(DOWNLOAD_TRIES):
            try:
                provider.fetch(url, str(local))
                media.probe(str(local))
                break
            except (TransientProviderError, media.MediaError) as e:
                last = e
                self.d.sleep(self.d.poll_seconds if attempt < DOWNLOAD_TRIES - 1 else 0)
        else:
            raise ClipOutcomeUnknown(f"couldn't download the finished clip: {last}")  # already billed
        remote = f"walkthroughs/{eid}/{wid}/clips/{index}-g{clip.get('gen', 1)}.mp4"
        self.d.storage.upload(str(local), remote, "video/mp4")
        old = clip.get("storagePath")
        self._update_clip(eid, wid, index, status="ready", storagePath=remote, oldPath=old if old != remote else None,
                          providerRef=None, error=None, doneAt=self.d.now())

    # -------------------------------------------------------------- joining
    def _join(self, eid, wid, job: dict, frames: dict, tmp: Path) -> None:
        wt = self._read(eid, wid)
        w, h = size_for(wt["aspect"], wt["resolution"])
        segments: list[media.Segment] = []
        if job.get("holdStart"):
            path = str(tmp / "hold-start.mp4")
            media.hold_clip(frames[0]["path"], path, job["holdStart"], w, h, job.get("holdZoom", False))
            segments.append(media.Segment(path, job["holdStart"]))
        for clip in wt["clips"]:
            local = str(tmp / f"clip-{clip['index']}.mp4")
            self.d.storage.download(clip["storagePath"], local)
            segments.append(media.Segment(local, wt["clipSeconds"], clip.get("slowdown", 1.0)))
        if job.get("holdEnd"):
            path = str(tmp / "hold-end.mp4")
            last = max(frames)
            media.hold_clip(frames[last]["path"], path, job["holdEnd"], w, h, job.get("holdZoom", False))
            segments.append(media.Segment(path, job["holdEnd"]))

        final = str(tmp / "final.mp4")
        expected = sum(s.output_seconds for s in segments)
        try:
            media.join_segments(segments, final, wt["aspect"], wt["resolution"])
        except media.MediaError as e:  # one retry for the join too
            self.d.log(f"Walkthrough {eid}/{wid}: join failed, trying again: {e}")
            media.join_segments(segments, final, wt["aspect"], wt["resolution"])
        info = media.check_final(final, wt["aspect"], wt["resolution"], expected)
        poster = str(tmp / "poster.jpg")
        media.poster_frame(final, poster)

        version = wt.get("videoVersion", 0) + 1
        video_path = f"walkthroughs/{eid}/{wid}/final-v{version}.mp4"
        poster_path = f"walkthroughs/{eid}/{wid}/poster-v{version}.jpg"
        video_url = self.d.storage.upload(final, video_path, "video/mp4")
        poster_url = self.d.storage.upload(poster, poster_path, "image/jpeg")
        old = [p for p in (wt.get("videoPath"), wt.get("posterPath")) if p]
        old += [c["oldPath"] for c in wt["clips"] if c.get("oldPath")]
        clips = [{**c, "oldPath": None} for c in wt["clips"]]
        self._set_status(eid, wid, status="preview", clips=clips, videoUrl=video_url, posterUrl=poster_url, videoPath=video_path,
                         posterPath=poster_path, videoVersion=version, durationSeconds=round(info["duration"], 2),
                         width=info["width"], height=info["height"], error=None, errorKind=None)

        for path in old:
            self.d.storage.delete(path)

    # -------------------------------------------------------------- the sweep
    def sweep(self) -> dict:
        """Runs on a schedule. Restarts jobs whose worker went quiet, and clears out what's left
        when an event is deleted (the app can't delete these files or records itself)."""
        now = self.d.now()
        restarted, purged = 0, 0
        for snap in self.db.collection(JOBS).stream():
            job = snap.to_dict() or {}
            eid, wid = job.get("eventId"), job.get("walkthroughId")
            if not eid or not wid:
                continue
            if not self.db.collection("events").document(eid).get().exists:
                self.delete(eid=eid, wid=wid)  # closes its reservations and removes its files
                self.usage_ref(f"event-{eid}").delete()
                snap.reference.delete()
                purged += 1
                continue
            if job.get("active") and job.get("leaseUntil", 0) < now:
                self._spawn(eid, wid)
                restarted += 1
        return {"restarted": restarted, "purged": purged}

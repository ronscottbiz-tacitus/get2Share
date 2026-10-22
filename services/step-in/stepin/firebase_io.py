"""
Firebase access for the Step In cloud job, using a service account.

Environment (set as a Modal secret):
  FIREBASE_SERVICE_ACCOUNT   the service account key, as JSON text
  FIREBASE_STORAGE_BUCKET    e.g. get2share.firebasestorage.app
  STEP_IN_ADMIN_EMAILS       optional, comma-separated: these accounts can use Step In on any event
  STEP_IN_CLEANUP            "delete" to really delete expired events; anything else = report only
"""
from __future__ import annotations

import base64
import io
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

ALBUM_DAYS = 30  # matches ALBUM_DAYS in src/events.ts
DEFAULT_ADMINS = "ronaldscott.ca@gmail.com,ronscottbiz@gmail.com"  # matches storage.rules

_app = None


def app():
    global _app
    if _app is None:
        import firebase_admin
        from firebase_admin import credentials
        cred = credentials.Certificate(json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"]))
        _app = firebase_admin.initialize_app(cred, {"storageBucket": os.environ["FIREBASE_STORAGE_BUCKET"]})
    return _app


def db():
    from firebase_admin import firestore
    return firestore.client(app())


def bucket():
    from firebase_admin import storage
    return storage.bucket(app=app())


def admin_emails() -> set[str]:
    raw = os.environ.get("STEP_IN_ADMIN_EMAILS", DEFAULT_ADMINS)
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


# ------------------------------------------------------------------ auth
def verify_host(id_token: str, event_id: str) -> tuple[str, dict]:
    """Returns (uid, event) if the caller hosts this event and Step In is on for it.
    Raises PermissionError with a message the app can show."""
    from firebase_admin import auth
    try:
        claims = auth.verify_id_token(id_token, app=app())
    except Exception:
        raise PermissionError("Your sign-in expired. Reload the page and try again.")
    uid = claims["uid"]
    snap = db().collection("events").document(event_id).get()
    if not snap.exists:
        raise PermissionError("That event no longer exists.")
    ev = snap.to_dict()
    if uid != ev.get("ownerUid") and uid not in (ev.get("hostUids") or []):
        raise PermissionError("Only hosts can make Step In moments.")
    is_admin = claims.get("email_verified") and (claims.get("email") or "").lower() in admin_emails()
    if not (ev.get("pro") or is_admin):
        raise PermissionError("Step In is a Pro feature.")
    return uid, ev


# ------------------------------------------------------------------ photos
def photo_ref(event_id: str, photo_id: str):
    return db().collection("events").document(event_id).collection("photos").document(photo_id)


def set_status(event_id: str, photo_id: str, **fields) -> None:
    from firebase_admin import firestore
    fields["updatedAt"] = firestore.SERVER_TIMESTAMP
    photo_ref(event_id, photo_id).update({f"stepIn.{k}": v for k, v in fields.items()})


def load_photo(event_id: str, photo_id: str):
    """The original photo as a PIL image (download link or the older inline data: link)."""
    import requests
    from PIL import Image
    snap = photo_ref(event_id, photo_id).get()
    if not snap.exists:
        raise FileNotFoundError("That photo was deleted.")
    url = (snap.to_dict() or {}).get("url") or ""
    if url.startswith("data:"):
        raw = base64.b64decode(url.split(",", 1)[1])
    else:
        r = requests.get(url, timeout=60)
        r.raise_for_status()
        raw = r.content
    return Image.open(io.BytesIO(raw))


def upload(local_path: str, remote_path: str, content_type="application/octet-stream") -> str:
    """Upload a file and return a Firebase download link for it."""
    token = str(uuid.uuid4())
    blob = bucket().blob(remote_path)
    blob.metadata = {"firebaseStorageDownloadTokens": token}
    blob.cache_control = "public, max-age=31536000, immutable"
    blob.upload_from_filename(local_path, content_type=content_type)
    return (f"https://firebasestorage.googleapis.com/v0/b/{bucket().name}/o/"
            f"{quote(remote_path, safe='')}?alt=media&token={token}")


# ------------------------------------------------------------------ cleanup
def expired_events(now: datetime | None = None):
    """Events past their album date, the same rule the app uses (eventPhase in src/events.ts).
    Events marked keep: true are never touched."""
    now = now or datetime.now(timezone.utc)
    seen = set()
    for snap in db().collection("events").where("expireAt", "<", now).stream():
        seen.add(snap.id)
        if not (snap.to_dict() or {}).get("keep"):
            yield snap
    # Older events without expireAt: 30 days after they ended
    cutoff = now - timedelta(days=ALBUM_DAYS)
    for snap in db().collection("events").where("endsAt", "<", cutoff).stream():
        ev = snap.to_dict() or {}
        if snap.id not in seen and not ev.get("expireAt") and not ev.get("keep"):
            yield snap


def cleanup(live: bool, log=print) -> dict:
    """Delete everything for expired events: Storage files, every Firestore record
    under the event, and its join code. With live=False it only reports."""
    totals = {"events": 0, "files": 0, "bytes": 0}
    b = bucket()
    for snap in expired_events():
        ev = snap.to_dict() or {}
        eid = snap.id
        blobs = []
        for prefix in (f"events/{eid}/", f"moments/{eid}/"):
            blobs.extend(b.list_blobs(prefix=prefix))
        size = sum(x.size or 0 for x in blobs)
        totals["events"] += 1
        totals["files"] += len(blobs)
        totals["bytes"] += size
        log(f"{'Deleting' if live else 'Would delete'} {ev.get('name', eid)!r} ({eid}): "
            f"{len(blobs)} files, {size / 1e6:.1f} MB")
        if not live:
            continue
        for x in blobs:
            try:
                x.delete()
            except Exception as e:  # already gone is fine
                log(f"  couldn't delete {x.name}: {e}")
        code = ev.get("joinCode")
        if code:
            db().collection("joinCodes").document(code).delete()
        db().recursive_delete(snap.reference)
    log(f"{'Deleted' if live else 'Would delete'} {totals['events']} expired events, "
        f"{totals['files']} files, {totals['bytes'] / 1e6:.1f} MB.")
    return totals

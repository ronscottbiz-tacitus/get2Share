"""Connects the Walkthrough service to real Firebase and real providers. Used on Modal only."""
from __future__ import annotations

import os
import time

from stepin import firebase_io as fb

from .providers import get_provider
from .service import Deps, Service
from .transactions import run_transaction


class FirebaseStorage:
    def upload(self, local: str, remote: str, content_type: str) -> str:
        return fb.upload(local, remote, content_type)

    def download(self, remote: str, local: str) -> None:
        fb.bucket().blob(remote).download_to_filename(local)

    def exists(self, remote: str) -> bool:
        return fb.bucket().blob(remote).exists()

    def delete(self, remote: str) -> None:
        try:
            fb.bucket().blob(remote).delete()
        except Exception as e:  # already gone is fine
            print(f"couldn't delete {remote}: {e}")

    def delete_prefix(self, prefix: str) -> None:
        for blob in fb.bucket().list_blobs(prefix=prefix):
            self.delete(blob.name)

    def rotate(self, remote: str) -> str:
        return fb.rotate_download_link(remote)


def email_is_invited(claims: dict, emails) -> bool:
    """Only a verified email counts, the same bar admins have to clear."""
    email = (claims.get("email") or "").strip().lower()
    if not email or not claims.get("email_verified") or not isinstance(emails, (list, tuple)):
        return False
    return email in {str(e).strip().lower() for e in emails}


def active_grant_seconds(claims: dict, grants, now: float) -> float | None:
    """config/flowGrants: { grants: [{ email, seconds, until? }] }. Same verified-email bar as an
    invite. A grant past its `until`, or one with bad values, counts as no grant."""
    email = (claims.get("email") or "").strip().lower()
    if not email or not claims.get("email_verified") or not isinstance(grants, (list, tuple)):
        return None
    for g in grants:
        if not isinstance(g, dict) or str(g.get("email") or "").strip().lower() != email:
            continue
        seconds, until = g.get("seconds"), g.get("until")
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or seconds <= 0:
            continue
        if until is not None and (not hasattr(until, "timestamp") or until.timestamp() <= now):
            continue
        return float(seconds)
    return None


def flow_access(id_token: str) -> tuple[bool, float | None]:
    """(is invited, grant seconds or None). No client can read either list (see firestore.rules)."""
    from firebase_admin import auth
    claims = auth.verify_id_token(id_token, app=fb.app())
    config = fb.db().collection("config")
    invites = config.document("flowInvites").get()
    grants = config.document("flowGrants").get()
    return (email_is_invited(claims, (invites.to_dict() or {}).get("emails")) if invites.exists else False,
            active_grant_seconds(claims, (grants.to_dict() or {}).get("grants"), time.time()) if grants.exists else None)


def _run_tx(fn):
    return run_transaction(fb.db(), fn)


def service(spawn) -> Service:
    from firebase_admin import firestore
    return Service(Deps(
        db=fb.db(),
        run_tx=_run_tx,
        storage=FirebaseStorage(),
        load_photo=fb.load_photo,
        provider_for=lambda name, model: get_provider(name, model),
        spawn=spawn,
        server_time=firestore.SERVER_TIMESTAMP,
        env=dict(os.environ),
    ))

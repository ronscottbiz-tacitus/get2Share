"""Connects the Walkthrough service to real Firebase and real providers. Used on Modal only."""
from __future__ import annotations

import os

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


def is_invited(id_token: str) -> bool:
    """config/flowInvites: { emails: [...] }. No client can read it (see firestore.rules)."""
    from firebase_admin import auth
    snap = fb.db().collection("config").document("flowInvites").get()
    if not snap.exists:
        return False
    return email_is_invited(auth.verify_id_token(id_token, app=fb.app()), (snap.to_dict() or {}).get("emails"))


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

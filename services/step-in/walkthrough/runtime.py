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

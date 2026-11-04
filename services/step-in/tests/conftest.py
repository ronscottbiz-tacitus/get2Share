"""Shared test fixtures: an in-memory Firestore (or the real emulator, when it is running), a
folder standing in for Storage, and the fake video provider. No test touches the network."""
from __future__ import annotations

import copy
import os
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from google.cloud.firestore import SERVER_TIMESTAMP  # noqa: E402
from PIL import Image  # noqa: E402

from walkthrough.providers import FakeProvider  # noqa: E402
from walkthrough.service import Deps, Service  # noqa: E402
from walkthrough.transactions import run_transaction  # noqa: E402


# ------------------------------------------------------------------ in-memory Firestore
class Snap:
    def __init__(self, ref, data):
        self.reference, self._data = ref, data
        self.id = ref.id
        self.exists = data is not None

    def to_dict(self):
        return copy.deepcopy(self._data)


def _resolve(db, data):
    return {k: (db.clock() if v is SERVER_TIMESTAMP else v) for k, v in data.items()}


class DocRef:
    def __init__(self, db, path):
        self.db, self.path, self.id = db, path, path.rsplit("/", 1)[-1]

    def collection(self, name):
        return ColRef(self.db, f"{self.path}/{name}")

    def get(self, transaction=None):
        if transaction is not None and transaction.writes:
            raise AssertionError("Firestore transactions must do all reads before any write")
        with self.db.lock:
            return Snap(self, copy.deepcopy(self.db.docs.get(self.path)))

    def set(self, data, merge=False):
        with self.db.lock:
            fresh = _resolve(self.db, copy.deepcopy(data))
            self.db.docs[self.path] = {**self.db.docs.get(self.path, {}), **fresh} if merge else fresh

    def update(self, data):
        with self.db.lock:
            if self.path not in self.db.docs:
                raise KeyError(f"no document {self.path}")
            self.db.docs[self.path].update(_resolve(self.db, copy.deepcopy(data)))

    def delete(self):
        with self.db.lock:
            self.db.docs.pop(self.path, None)


class ColRef:
    def __init__(self, db, path):
        self.db, self.path = db, path

    def document(self, doc_id):
        return DocRef(self.db, f"{self.path}/{doc_id}")

    def stream(self):
        with self.db.lock:
            prefix = self.path + "/"
            rows = [p for p in self.db.docs if p.startswith(prefix) and "/" not in p[len(prefix):]]
        for p in rows:
            yield DocRef(self.db, p).get()


class Tx:
    def __init__(self):
        self.writes = []

    def set(self, ref, data, merge=False):
        self.writes.append(lambda: ref.set(data, merge=merge))

    def update(self, ref, data):
        self.writes.append(lambda: ref.update(data))

    def delete(self, ref):
        self.writes.append(ref.delete)


class FakeDb:
    """The parts of the Firestore client the service uses. A transaction holds the lock throughout,
    and its writes only land if it finishes, as in the real thing."""
    def __init__(self, clock):
        self.docs, self.clock = {}, clock
        self.lock = threading.RLock()

    def collection(self, name):
        return ColRef(self, name)

    def run_tx(self, fn):
        with self.lock:
            tx = Tx()
            result = fn(tx)
            for write in tx.writes:
                write()
            return result


# ------------------------------------------------------------------ Storage in a folder
class FolderStorage:
    def __init__(self, root: Path):
        self.root, self.tokens, self.uploads = root, {}, []

    def _p(self, remote):
        return self.root / remote

    def upload(self, local, remote, content_type):
        p = self._p(remote)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(Path(local).read_bytes())
        self.uploads.append(remote)
        self.tokens[remote] = self.tokens.get(remote, 0) + 1
        return f"https://storage.test/{remote}?token={self.tokens[remote]}"

    def download(self, remote, local):
        Path(local).write_bytes(self._p(remote).read_bytes())

    def exists(self, remote):
        return self._p(remote).exists()

    def delete(self, remote):
        self._p(remote).unlink(missing_ok=True)

    def delete_prefix(self, prefix):
        for p in list(self.root.rglob("*")):
            if p.is_file() and str(p.relative_to(self.root)).startswith(prefix):
                p.unlink()

    def rotate(self, remote):
        self.tokens[remote] = self.tokens.get(remote, 0) + 1
        return f"https://storage.test/{remote}?token={self.tokens[remote]}"

    def files(self, prefix=""):
        return sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*") if p.is_file()
                      and str(p.relative_to(self.root)).startswith(prefix))


class Clock:
    def __init__(self, t=1_790_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


COLORS = ["#c0392b", "#27ae60", "#2980b9", "#8e44ad", "#f39c12", "#16a085", "#d35400"]


class World:
    """One test's whole setup."""
    def __init__(self, db, run_tx, tmp: Path, server_time):
        self.db = db
        self.clock = Clock()
        self.storage = FolderStorage(tmp / "bucket")
        self.script = {}
        self.provider = FakeProvider(out_dir=str(self._mk(tmp / "fake")), script=self.script)
        self.spawned = []
        self.provider_error = None
        self.deleted_photos = set()
        self.deps = Deps(
            db=db, run_tx=run_tx, storage=self.storage, load_photo=self.load_photo,
            provider_for=self.provider_for, spawn=lambda e, w: self.spawned.append((e, w)),
            server_time=server_time, now=self.clock, sleep=self.clock.sleep, log=print,
        )
        self.svc = Service(self.deps)

    @staticmethod
    def _mk(p):
        p.mkdir(parents=True, exist_ok=True)
        return p

    def provider_for(self, name, model):
        if self.provider_error:
            raise self.provider_error
        return self.provider

    def load_photo(self, eid, photo_id):
        if photo_id in self.deleted_photos:
            raise FileNotFoundError("That photo was deleted.")
        i = int(photo_id[1:]) if photo_id[1:].isdigit() else 0
        return Image.new("RGB", (1600, 1200), COLORS[i % len(COLORS)])

    def configure(self, **fields):
        self.db.collection("config").document("walkthrough").set(
            {"enabled": True, "allHosts": True, "provider": "fake", **fields})

    def add_event(self, eid="ev1", count=7, owner="host1"):
        self.db.collection("events").document(eid).set({"name": "Party", "ownerUid": owner, "hostUids": [owner]})
        for i in range(count):
            self.db.collection("events").document(eid).collection("photos").document(f"p{i}").set(
                {"status": "approved", "createdAt": i, "url": f"https://x/p{i}.jpg"})

    def create(self, eid="ev1", uid="host1", photos=("p0", "p1", "p2", "p3"), preset="15s", aspect="9:16", rid="r1",
               is_admin=False, accepted=True):
        return self.svc.create(uid=uid, is_admin=is_admin, eid=eid, event={}, photo_ids=list(photos), preset_id=preset,
                               aspect=aspect, accepted_notice=accepted, notice_version=2, request_id=rid)

    def doc(self, eid, wid):
        return self.svc.wt_ref(eid, wid).get().to_dict()

    def job(self, eid, wid):
        return self.svc.job_ref(eid, wid).get().to_dict()

    def usage(self, key):
        snap = self.svc.usage_ref(key).get()
        return snap.to_dict() if snap.exists else {}

    def budget(self):
        from walkthrough.config import month_key
        return self.usage(f"global-{month_key(self.clock())}")


@pytest.fixture
def world(tmp_path):
    clock_holder = {}
    db = FakeDb(lambda: clock_holder["clock"]())
    w = World(db, db.run_tx, tmp_path, SERVER_TIMESTAMP)
    clock_holder["clock"] = w.clock
    return w


def _emulator_world(tmp_path):
    """The same service against the real Firestore emulator, so real transactions are exercised."""
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import firestore
    project = f"demo-wt-{os.getpid()}"
    db = firestore.Client(project=project, credentials=AnonymousCredentials())

    def run_tx(fn):
        return run_transaction(db, fn)

    return World(db, run_tx, tmp_path, SERVER_TIMESTAMP)


@pytest.fixture
def emulator_world(tmp_path):
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        pytest.skip("Firestore emulator isn't running")
    w = _emulator_world(tmp_path)
    for col in ("config", "events", "walkthroughJobs", "walkthroughUsage"):
        for doc in w.db.collection(col).stream():
            w.db.recursive_delete(doc.reference)
    return w

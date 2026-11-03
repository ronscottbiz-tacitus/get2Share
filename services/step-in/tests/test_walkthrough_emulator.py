"""The same job against the real Firestore emulator, so real transactions are exercised, including
many hosts racing for the same budget. Skipped unless FIRESTORE_EMULATOR_HOST is set."""
from concurrent.futures import ThreadPoolExecutor

from walkthrough.service import ApiError


def test_full_run_on_real_firestore(emulator_world):
    w = emulator_world
    w.configure(prices={"fake": {"720p": 0.1}})
    w.add_event()
    r = w.create()
    assert w.svc.run("ev1", r["id"]) == "preview"
    doc = w.doc("ev1", r["id"])
    assert doc["status"] == "preview" and doc["durationSeconds"] > 14
    assert w.svc.redo(uid="host1", is_admin=False, eid="ev1", wid=r["id"], clip_index=1)["status"] == "queued"
    assert w.svc.run("ev1", r["id"]) == "preview"
    assert w.budget()["reservedUsd"] == 0 and w.budget()["spentUsd"] == 2.0
    w.svc.approve(uid="host1", eid="ev1", wid=r["id"])
    w.svc.unpublish(eid="ev1", wid=r["id"])
    w.svc.delete(eid="ev1", wid=r["id"])
    assert not w.svc.wt_ref("ev1", r["id"]).get().exists


def test_budget_holds_when_hosts_race(emulator_world):
    w = emulator_world
    w.configure(prices={"fake": {"720p": 0.1}}, budget={"monthlyUsd": 4.5})  # room for exactly 3
    for i in range(12):
        w.add_event(f"e{i}", count=4)

    def attempt(i):
        try:
            w.create(eid=f"e{i}", uid=f"host{i}", rid="r")
            return True
        except ApiError as e:
            assert e.status == 429
            return False

    with ThreadPoolExecutor(12) as pool:
        wins = sum(pool.map(attempt, range(12)))
    assert wins == 3
    assert w.budget()["reservedUsd"] == 4.5


def test_event_limit_holds_when_tapped_at_once(emulator_world):
    w = emulator_world
    w.configure()
    w.add_event()

    def attempt(i):
        try:
            w.create(rid=f"r{i}")
            return True
        except ApiError as e:
            assert e.status in (409, 429)
            return False

    with ThreadPoolExecutor(8) as pool:
        wins = sum(pool.map(attempt, range(8)))
    assert wins == 1
    assert w.usage("event-ev1")["videos"] == 1

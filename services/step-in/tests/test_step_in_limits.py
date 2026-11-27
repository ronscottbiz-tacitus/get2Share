"""Step In spending limits (stepin/limits.py): caps per event, per host per month and per month,
one job per photo at a time, and warm-ups at most every few minutes."""
import threading

import pytest

from conftest import FakeDb
from stepin import limits

NOW = 1_790_000_000.0  # 2026-09-21 UTC
MONTH = limits.month_key(NOW)


class World:
    def __init__(self):
        self.t = NOW
        self.db = FakeDb(lambda: self.t)
        self.config = {}

    def photo(self, pid="p1", eid="ev1", step_in=None):
        data = {"url": "x", "sessionId": "maya"}
        if step_in is not None:
            data["stepIn"] = step_in
        self.db.collection("events").document(eid).collection("photos").document(pid).set(data)

    def step_in(self, pid="p1", eid="ev1"):
        snap = self.db.collection("events").document(eid).collection("photos").document(pid).get()
        return (snap.to_dict() or {}).get("stepIn")

    def usage(self, key):
        snap = self.db.collection("stepInUsage").document(key).get()
        return snap.to_dict() or {} if snap.exists else {}

    def claim(self, pid="p1", eid="ev1", uid="host1", admin=False, redo=False):
        """The status, with "started" when this call started a job."""
        started, status = limits.claim(self.db, self.db.run_tx, now=self.t, server_time=self.t,
                            event_id=eid, photo_id=pid, uid=uid, is_admin=admin, redo=redo,
                            config=self.config)
        return "started" if started else status

    def warm(self, eid="ev1"):
        return limits.may_warm(self.db, self.db.run_tx, now=self.t, event_id=eid, config=self.config)


@pytest.fixture
def w():
    return World()


def test_a_first_request_queues_the_photo_and_counts_it(w):
    w.photo()
    assert w.claim() == "started"
    assert w.step_in()["status"] == "queued" and w.step_in()["requestedBy"] == "host1"
    assert w.usage("event-ev1") == {"moments": 1}
    assert w.usage(f"host-host1-{MONTH}") == {"moments": 1}
    assert w.usage(f"global-{MONTH}") == {"moments": 1}


def test_a_second_tap_starts_nothing(w):
    w.photo()
    assert w.claim() == "started"
    assert w.claim() == "queued"  # already queued: no second job, no second count
    assert w.usage(f"global-{MONTH}")["moments"] == 1


def test_two_requests_at_once_start_one_job(w):
    w.photo()
    results = []
    threads = [threading.Thread(target=lambda: results.append(w.claim(uid=f"h{i}"))) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("started") == 1 and results.count("queued") == 7
    assert w.usage(f"global-{MONTH}")["moments"] == 1


def test_a_ready_moment_needs_redo_and_a_redo_counts(w):
    w.photo(step_in={"status": "ready", "updatedAt": NOW - 30})
    assert w.claim() == "ready"
    assert w.usage(f"global-{MONTH}") == {}
    assert w.claim(redo=True) == "started"
    assert w.usage(f"global-{MONTH}")["moments"] == 1


def test_a_running_job_isnt_restarted_until_it_has_outlived_the_gpu_timeout(w):
    w.photo(step_in={"status": "processing", "updatedAt": NOW - limits.GPU_TIMEOUT_SECONDS})
    assert w.claim() == "processing"
    w.t = NOW + 61  # past the GPU's 10 minutes and a margin
    assert w.claim() == "started"
    assert limits.STALE_SECONDS > limits.GPU_TIMEOUT_SECONDS


def test_a_failed_moment_can_be_tried_again_and_counts_again(w):
    w.photo(step_in={"status": "failed", "updatedAt": NOW - 5})
    assert w.claim() == "started"
    assert w.usage("event-ev1")["moments"] == 1


def test_a_deleted_photo(w):
    with pytest.raises(FileNotFoundError, match="deleted"):
        w.claim()


def test_the_event_cap(w):
    w.config = {"limits": {"perEvent": 2}}
    for i in range(2):
        w.photo(f"p{i}")
        assert w.claim(f"p{i}") == "started"
    w.photo("p9")
    with pytest.raises(limits.LimitReached, match=r"This event has made all the Step In moments it can \(2\)"):
        w.claim("p9")
    assert w.step_in("p9") is None, "a refused request changes nothing"
    assert w.usage("event-ev1")["moments"] == 2


def test_the_host_cap_spans_events(w):
    w.config = {"limits": {"perHostPerMonth": 2}}
    for eid in ("ev1", "ev2"):
        w.photo(eid=eid)
        assert w.claim(eid=eid) == "started"
    w.photo(eid="ev3")
    with pytest.raises(limits.LimitReached, match="this month"):
        w.claim(eid="ev3")
    # Another host is unaffected.
    assert w.claim(eid="ev3", uid="host2") == "started"


def test_the_host_cap_resets_next_month(w):
    w.config = {"limits": {"perHostPerMonth": 1}}
    w.photo("p1")
    w.photo("p2")
    assert w.claim("p1") == "started"
    with pytest.raises(limits.LimitReached):
        w.claim("p2")
    w.t = NOW + 40 * 86400
    assert w.claim("p2") == "started"


def test_the_monthly_total_applies_to_everyone_even_admins(w):
    w.config = {"limits": {"perMonth": 1}}
    w.photo("p1", eid="ev1")
    w.photo("p2", eid="ev2")
    assert w.claim("p1", eid="ev1") == "started"
    with pytest.raises(limits.LimitReached, match="limit for this month"):
        w.claim("p2", eid="ev2", uid="other")
    with pytest.raises(limits.LimitReached, match="limit for this month"):
        w.claim("p2", eid="ev2", uid="ron", admin=True)


def test_admins_skip_the_event_and_host_caps(w):
    w.config = {"limits": {"perEvent": 1, "perHostPerMonth": 1}}
    for i in range(3):
        w.photo(f"p{i}")
        assert w.claim(f"p{i}", uid="ron", admin=True) == "started"


@pytest.mark.parametrize("config", [None, {}, {"limits": "lots"}, {"limits": {"perEvent": -1}},
                                    {"limits": {"perEvent": 2.5}}, {"limits": {"perEvent": True}},
                                    {"limits": {"perEvent": "999"}}, {"limits": {"perEvent": 10**9}}])
def test_a_missing_or_bad_setting_uses_the_default(config):
    assert limits.parse_limits(config)["perEvent"] == limits.DEFAULT_LIMITS["perEvent"]


def test_the_defaults():
    assert limits.DEFAULT_LIMITS == {"perEvent": 20, "perHostPerMonth": 60, "perMonth": 500, "warmsPerMonth": 600}
    assert limits.parse_limits({"limits": {"perMonth": 0}})["perMonth"] == 0  # 0 turns Step In off


def test_warm_at_most_every_few_minutes_per_event(w):
    assert w.warm() is True
    assert w.warm() is False
    w.t = NOW + limits.WARM_EVERY_SECONDS - 1
    assert w.warm() is False
    assert w.warm("ev2") is True  # another event isn't held back
    w.t = NOW + limits.WARM_EVERY_SECONDS
    assert w.warm() is True
    assert w.usage(f"global-{MONTH}")["warms"] == 3


def test_warm_ups_have_a_monthly_cap(w):
    w.config = {"limits": {"warmsPerMonth": 2}}
    assert w.warm("ev1") and w.warm("ev2")
    assert w.warm("ev3") is False
    assert w.usage(f"global-{MONTH}")["warms"] == 2


def test_odd_ids_make_safe_counter_names(w):
    w.photo(eid="ev/../x")
    assert w.claim(eid="ev/../x", uid="a/b") == "started"
    assert w.usage("event-ev____x")["moments"] == 1

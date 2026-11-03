"""The whole job with the fake provider, real ffmpeg, and an in-memory Firestore."""
import pytest

from walkthrough import media
from walkthrough.providers import ProviderNotReady
from walkthrough.service import ApiError, LEASE_SECONDS, MAX_RUNS, MSG_BLOCKED, MSG_BUDGET, MSG_OFF


def ready(world, **config):
    world.configure(**config)
    world.add_event()
    return world


def price(**extra):
    return {"prices": {"fake": {"720p": 0.1, "480p": 0.05}}, **extra}  # $0.50 a clip, $1.50 a 15 sec video


# ------------------------------------------------------------------ the happy path
def test_full_run_makes_a_labeled_preview(world):
    ready(world)
    r = world.create()
    assert r["status"] == "queued" and world.spawned == [("ev1", r["id"])]
    assert world.svc.run("ev1", r["id"]) == "preview"
    doc = world.doc("ev1", r["id"])
    assert doc["status"] == "preview"
    assert [c["status"] for c in doc["clips"]] == ["ready"] * 3
    assert doc["durationSeconds"] == pytest.approx(15.0, abs=0.3)
    assert (doc["width"], doc["height"]) == (720, 1280)
    assert doc["label"] == "AI-generated video. Some moments and details aren't real."
    assert doc["videoUrl"].startswith("https://storage.test/walkthroughs/ev1/")
    final = world.storage.root / doc["videoPath"]
    info = media.probe(str(final))
    assert info["codec"] == "h264" and info["has_audio"] is False
    assert media.moov_first(str(final))
    assert world.job("ev1", r["id"])["active"] is False


def test_neighboring_photos_become_start_and_end_frames(world):
    ready(world)
    r = world.create()
    world.svc.run("ev1", r["id"])
    doc = world.doc("ev1", r["id"])
    assert [(c["startPhotoId"], c["endPhotoId"]) for c in doc["clips"]] == [("p0", "p1"), ("p1", "p2"), ("p2", "p3")]
    reqs = world.provider.submitted
    assert [q.start_url.split("frames/")[1][0] + q.end_url.split("frames/")[1][0] for q in reqs] == ["01", "12", "23"]
    assert all(q.generate_audio is False and q.seconds == 5 and q.aspect == "9:16" and q.resolution == "720p" for q in reqs)


@pytest.mark.parametrize("preset,photos,clips,seconds", [("10s", 3, 2, 10), ("15s", 4, 3, 15)])
def test_presets(world, preset, photos, clips, seconds):
    ready(world)
    r = world.create(photos=[f"p{i}" for i in range(photos)], preset=preset)
    assert world.svc.run("ev1", r["id"]) == "preview"
    doc = world.doc("ev1", r["id"])
    assert len(doc["clips"]) == clips and doc["durationSeconds"] == pytest.approx(seconds, abs=0.3)


def test_a_larger_preset_needs_only_config(world):
    ready(world, presets=[{"id": "big", "label": "20 sec", "photos": 5, "clipSeconds": 5}], defaultPreset="big")
    r = world.create(photos=[f"p{i}" for i in range(5)], preset="big")
    world.svc.run("ev1", r["id"])
    assert world.doc("ev1", r["id"])["durationSeconds"] == pytest.approx(20, abs=0.3)


def test_horizontal_and_480p(world):
    ready(world, resolution="480p")
    r = world.create(aspect="16:9")
    world.svc.run("ev1", r["id"])
    doc = world.doc("ev1", r["id"])
    assert (doc["width"], doc["height"]) == (854, 480)


def test_slowdown_and_holds_from_config(world):
    ready(world, slowdown=[2.0], hold={"startSeconds": 1, "endSeconds": 2, "zoom": True})
    r = world.create()
    world.svc.run("ev1", r["id"])
    assert world.doc("ev1", r["id"])["durationSeconds"] == pytest.approx(10 + 5 + 5 + 3, abs=0.3)


def test_output_links_are_copied_to_storage_right_away(world):
    ready(world)
    r = world.create()
    world.svc.run("ev1", r["id"])
    assert len(world.storage.files(f"walkthroughs/ev1/{r['id']}/clips/")) == 3
    assert not any("fake-" in c.get("storagePath", "") for c in world.doc("ev1", r["id"])["clips"])


# ------------------------------------------------------------------ the notice and bad requests
def test_notice_must_be_accepted(world):
    ready(world)
    with pytest.raises(ApiError) as e:
        world.create(accepted=False)
    assert e.value.status == 400
    assert world.usage("event-ev1") == {}


def test_wrong_photo_count_or_duplicates(world):
    ready(world)
    for photos in (("p0", "p1"), ("p0", "p0", "p1", "p2")):
        with pytest.raises(ApiError):
            world.create(photos=photos)


def test_unapproved_or_missing_photos_refused(world):
    ready(world)
    world.db.collection("events").document("ev1").collection("photos").document("p1").update({"status": "pending"})
    with pytest.raises(ApiError) as e:
        world.create()
    assert e.value.status == 409
    with pytest.raises(ApiError):
        world.create(photos=("p0", "p2", "p3", "nope"))


def test_a_double_tap_makes_one_video(world):
    ready(world)
    a, b = world.create(rid="same"), world.create(rid="same")
    assert a["id"] == b["id"] and len(world.spawned) == 1
    assert world.usage("event-ev1")["videos"] == 1


# ------------------------------------------------------------------ access
def test_missing_config_is_off_even_for_admins(world):
    world.add_event()
    for admin in (False, True):
        with pytest.raises(ApiError) as e:
            world.create(is_admin=admin)
        assert e.value.status == 403


def test_off_switch(world):
    ready(world, enabled=False)
    with pytest.raises(ApiError) as e:
        world.create(is_admin=True)
    assert e.value.message == MSG_OFF


def test_starts_admin_only(world):
    ready(world, allHosts=False)
    with pytest.raises(ApiError) as e:
        world.create()
    assert e.value.status == 403
    assert world.create(is_admin=True)["status"] == "queued"


def test_no_provider_or_price_means_not_set_up(world):
    world.add_event()
    world.db.collection("config").document("walkthrough").set({"enabled": True, "allHosts": True})
    with pytest.raises(ApiError) as e:
        world.create()
    assert e.value.status == 503
    world.configure(provider="mystery")
    with pytest.raises(ApiError) as e:
        world.create()
    assert e.value.status == 503 and "price" in e.value.message
    world.configure(provider="fal")
    world.provider_error = ProviderNotReady("no key")
    with pytest.raises(ApiError) as e:
        world.create()
    assert e.value.status == 503
    assert world.usage("event-ev1") == {}


def test_off_switch_stops_a_running_job_before_more_spending(world):
    ready(world)
    r = world.create()
    world.configure(enabled=False)
    assert world.svc.run("ev1", r["id"]) == "failed"
    assert world.doc("ev1", r["id"])["error"] == MSG_OFF
    assert world.provider.submitted == []


# ------------------------------------------------------------------ limits
def test_one_video_per_event_by_default(world):
    ready(world)
    r = world.create(rid="a")
    world.svc.run("ev1", r["id"])
    with pytest.raises(ApiError) as e:
        world.create(rid="b")
    assert e.value.status == 429


def test_only_one_job_at_a_time_for_an_event(world):
    ready(world, limits={"videosPerEvent": 5})
    world.create(rid="a")
    with pytest.raises(ApiError) as e:
        world.create(rid="b")
    assert e.value.status == 409


def test_per_host_limit_catches_many_events(world):
    ready(world, limits={"videosPerHostPerMonth": 2})
    for i in range(3):
        world.add_event(f"e{i}")
    for i in range(2):
        world.svc.run(f"e{i}", world.create(eid=f"e{i}", rid="r")["id"])
    with pytest.raises(ApiError) as e:
        world.create(eid="e2", rid="r")
    assert e.value.status == 429 and "month" in e.value.message
    world.create(eid="e2", rid="r", uid="someone-else")  # another host is unaffected


def test_monthly_budget_cap_reserves_before_generating(world):
    ready(world, **price(budget={"monthlyUsd": 2}))
    for i in range(2):
        world.add_event(f"e{i}")
    world.create(eid="e0", rid="r")
    assert world.budget()["reservedUsd"] == 1.5
    with pytest.raises(ApiError) as e:
        world.create(eid="e1", rid="r", uid="other")
    assert e.value.message == MSG_BUDGET
    assert world.usage("event-e1") == {}
    assert world.provider.submitted == []


def test_spend_moves_from_reserved_to_spent(world):
    ready(world, **price())
    r = world.create()
    world.svc.run("ev1", r["id"])
    assert world.budget() == {"reservedUsd": 0, "spentUsd": 1.5}


# ------------------------------------------------------------------ content rejection
@pytest.mark.parametrize("step", ["blocked", "blocked_late"])
def test_face_rejection_is_friendly_final_and_free(world, step):
    ready(world, **price())
    world.script[1] = [step]
    r = world.create()
    assert world.svc.run("ev1", r["id"]) == "blocked"
    doc = world.doc("ev1", r["id"])
    assert doc["status"] == "blocked" and doc["errorKind"] == "blocked" and doc["error"] == MSG_BLOCKED
    assert [c["status"] for c in doc["clips"]] == ["ready", "blocked", "pending"]
    assert len(world.provider.submitted) == 2, "no retry, and no third clip after a refusal"
    assert world.usage("event-ev1")["videos"] == 0
    assert world.usage("event-ev1")["activeJob"] is None
    assert world.budget() == {"reservedUsd": 0, "spentUsd": 0.5}, "one finished clip, rejected and unsent ones released"
    with pytest.raises(ApiError) as e:
        world.svc.redo(uid="host1", is_admin=False, eid="ev1", wid=r["id"], clip_index=1)
    assert e.value.status == 409
    world.create(rid="new", photos=("p3", "p4", "p5", "p6"))  # different photos are allowed


# ------------------------------------------------------------------ transient failures
@pytest.mark.parametrize("step", ["transient", "transient_late"])
def test_one_automatic_retry(world, step):
    ready(world, **price())
    world.script[0] = [step, "ok"]
    r = world.create()
    assert world.svc.run("ev1", r["id"]) == "preview"
    assert len(world.provider.submitted) == 4
    assert world.doc("ev1", r["id"])["clips"][0]["attempt"] == 2
    assert world.budget() == {"reservedUsd": 0, "spentUsd": 1.5}, "the failed try wasn't charged"


def test_second_failure_fails_the_video_without_counting(world):
    ready(world, **price())
    world.script[0] = ["transient", "transient"]
    r = world.create()
    assert world.svc.run("ev1", r["id"]) == "failed"
    doc = world.doc("ev1", r["id"])
    assert doc["status"] == "failed" and doc["errorKind"] == "failed"
    assert len(world.provider.submitted) == 2
    assert world.usage("event-ev1")["videos"] == 0
    assert world.budget() == {"reservedUsd": 0}


def test_try_again_keeps_finished_clips(world):
    ready(world, **price())
    world.script[1] = ["transient", "transient"]
    r = world.create()
    world.svc.run("ev1", r["id"])
    assert world.budget()["spentUsd"] == 0.5
    sent_before = len(world.provider.submitted)
    assert world.svc.redo(uid="host1", is_admin=False, eid="ev1", wid=r["id"], clip_index=1)["status"] == "queued"
    assert world.usage("event-ev1")["videos"] == 1
    assert world.doc("ev1", r["id"])["redosUsed"] == 0
    assert world.svc.run("ev1", r["id"]) == "preview"
    assert len(world.provider.submitted) == sent_before + 2, "only the two unfinished clips"
    assert world.budget() == {"reservedUsd": 0, "spentUsd": 1.5}


def test_a_bad_request_is_not_retried(world):
    ready(world)
    world.script[0] = ["reject"]
    r = world.create()
    assert world.svc.run("ev1", r["id"]) == "failed"
    assert len(world.provider.submitted) == 1


def test_a_poll_that_times_out_counts_as_spent_and_retries(world):
    ready(world, **price())
    world.provider.polls = 10**9
    world.deps.poll_timeout = 30
    r = world.create()
    assert world.svc.run("ev1", r["id"]) == "failed"
    assert len(world.provider.submitted) == 2
    assert world.budget()["spentUsd"] == 1.0, "unknown outcomes are assumed billed"
    assert world.budget()["reservedUsd"] == 0


def test_a_budget_hit_during_retry_stops_the_job(world):
    ready(world, **price(budget={"monthlyUsd": 1.5}))
    world.script[0] = ["transient_late", "ok"]
    world.provider.polls = 1
    r = world.create()
    # Something else takes the room the released first try gave back.
    orig = world.svc._settle

    def settle_then_fill(eid, wid, key, outcome):
        orig(eid, wid, key, outcome)
        from walkthrough.config import month_key
        ref = world.svc.usage_ref(f"global-{month_key(world.clock())}")
        ref.set({**(ref.get().to_dict() or {}), "spentUsd": 100})
    world.svc._settle = settle_then_fill
    assert world.svc.run("ev1", r["id"]) == "failed"
    assert world.doc("ev1", r["id"])["error"] == MSG_BUDGET
    assert world.usage("event-ev1")["videos"] == 0


def test_a_deleted_photo_stops_the_job_before_any_spending(world):
    ready(world)
    r = world.create()
    world.deleted_photos.add("p2")
    assert world.svc.run("ev1", r["id"]) == "failed"
    assert world.provider.submitted == []
    assert "deleted" in world.doc("ev1", r["id"])["error"]


# ------------------------------------------------------------------ resuming
def test_resume_skips_finished_clips_and_polls_the_one_in_flight(world):
    ready(world, **price())
    r = world.create()
    wid = r["id"]
    # Worker dies mid clip 1: clip 0 is done, clip 1 is at the provider.
    world.provider.polls = 1
    orig = world.svc._do_clip

    def die_on_second(eid, w, me, index, provider, frames, wt, tmp):
        if index == 1:
            world.svc._reserve(eid, w, "1-1-1")
            world.svc._update_clip(eid, w, 1, status="submitting")
            ref = provider.submit(world.svc._request(w, 1, world.doc(eid, w)["clips"][1], frames, wt, world.svc.job_ref(eid, w)))
            world.svc._update_clip(eid, w, 1, status="submitted", providerRef=ref)
            raise SystemExit("worker died")
        return orig(eid, w, me, index, provider, frames, wt, tmp)
    world.svc._do_clip = die_on_second
    with pytest.raises(SystemExit):
        world.svc.run("ev1", wid)
    world.svc._do_clip = orig
    assert len(world.provider.submitted) == 2

    # Its lease was released on the way out in this test; a real crash leaves it to run out.
    world.svc.job_ref("ev1", wid).update({"leaseOwner": "dead-worker", "leaseUntil": world.clock() + LEASE_SECONDS})
    assert world.svc.run("ev1", wid) == "busy"
    world.clock.t += LEASE_SECONDS + 1
    assert world.svc.sweep()["restarted"] == 1
    assert world.spawned[-1] == ("ev1", wid)
    assert world.svc.run("ev1", wid) == "preview"
    assert len(world.provider.submitted) == 3, "clip 0 not repeated, clip 1 not resubmitted"
    assert world.budget() == {"reservedUsd": 0, "spentUsd": 1.5}


def test_died_while_sending_is_treated_as_possibly_billed(world):
    ready(world, **price())
    r = world.create()
    world.svc._update_clip("ev1", r["id"], 0, status="submitting")
    assert world.svc.run("ev1", r["id"]) == "preview"
    assert world.budget() == {"reservedUsd": 0, "spentUsd": 2.0}, "the lost send counted, plus 3 finished clips"
    assert world.doc("ev1", r["id"])["clips"][0]["attempt"] == 2


def test_running_twice_does_nothing_more(world):
    ready(world)
    r = world.create()
    world.svc.run("ev1", r["id"])
    sent = len(world.provider.submitted)
    assert world.svc.run("ev1", r["id"]) == "inactive"
    assert len(world.provider.submitted) == sent


def test_a_live_lease_blocks_a_second_worker(world):
    ready(world)
    r = world.create()
    world.svc.job_ref("ev1", r["id"]).update({"leaseOwner": "other", "leaseUntil": world.clock() + 100})
    assert world.svc.run("ev1", r["id"]) == "busy"
    assert world.provider.submitted == []


def test_a_job_that_keeps_dying_gives_up_and_refunds(world):
    ready(world, **price())
    r = world.create()
    world.svc.job_ref("ev1", r["id"]).update({"runs": MAX_RUNS})
    assert world.svc.run("ev1", r["id"]) == "failed"
    assert world.usage("event-ev1")["videos"] == 0
    assert world.budget()["reservedUsd"] == 0


def test_sweep_leaves_healthy_jobs_alone(world):
    ready(world)
    r = world.create()
    assert world.svc.sweep() == {"restarted": 0, "purged": 0}  # still inside the start grace period
    world.svc.job_ref("ev1", r["id"]).update({"leaseOwner": "w", "leaseUntil": world.clock() + 100})
    assert world.svc.sweep()["restarted"] == 0


def test_sweep_clears_up_after_a_deleted_event(world):
    ready(world, **price())
    r = world.create()
    world.svc.run("ev1", r["id"])
    world.db.collection("events").document("ev1").delete()
    assert world.svc.sweep()["purged"] == 1
    assert world.storage.files("walkthroughs/ev1/") == []
    assert not world.svc.job_ref("ev1", r["id"]).get().exists
    assert not world.svc.wt_ref("ev1", r["id"]).get().exists


# ------------------------------------------------------------------ redo
def preview(world, **config):
    ready(world, **price(**config))
    r = world.create()
    world.svc.run("ev1", r["id"])
    return r["id"]


def redo(world, wid, clip=1, uid="host1"):
    return world.svc.redo(uid=uid, is_admin=False, eid="ev1", wid=wid, clip_index=clip)


def test_redo_pays_for_one_clip_and_rejoins(world):
    wid = preview(world)
    before = world.doc("ev1", wid)
    sent = len(world.provider.submitted)
    assert redo(world, wid)["status"] == "queued"
    assert world.svc.run("ev1", wid) == "preview"
    after = world.doc("ev1", wid)
    assert len(world.provider.submitted) == sent + 1
    assert world.provider.submitted[-1].start_url.split("frames/")[1][0] == "1"
    assert after["videoVersion"] == 2 and after["videoUrl"] != before["videoUrl"]
    assert after["clips"][0]["storagePath"] == before["clips"][0]["storagePath"]
    assert after["clips"][1]["storagePath"] != before["clips"][1]["storagePath"]
    assert after["redosUsed"] == 1
    assert world.budget() == {"reservedUsd": 0, "spentUsd": 2.0}
    files = world.storage.files(f"walkthroughs/ev1/{wid}/")
    assert before["videoPath"] not in files and before["clips"][1]["storagePath"] not in files
    assert after["videoPath"] in files
    assert media.probe(str(world.storage.root / after["videoPath"]))["duration"] == pytest.approx(15, abs=0.3)


def test_two_redos_per_event_by_default(world):
    wid = preview(world)
    for clip in (0, 1):
        redo(world, wid, clip)
        world.svc.run("ev1", wid)
    with pytest.raises(ApiError) as e:
        redo(world, wid, 2)
    assert e.value.status == 429


def test_per_host_redo_limit(world):
    wid = preview(world, limits={"redosPerHostPerMonth": 1})
    redo(world, wid)
    world.svc.run("ev1", wid)
    with pytest.raises(ApiError) as e:
        redo(world, wid)
    assert "month" in e.value.message


@pytest.mark.parametrize("step", ["blocked", "transient"])
def test_failed_redo_keeps_the_video_and_gives_the_redo_back(world, step):
    wid = preview(world)
    before = world.doc("ev1", wid)
    world.script[2] = [step, step]
    redo(world, wid, 2)
    world.svc.run("ev1", wid)
    after = world.doc("ev1", wid)
    assert after["status"] == "preview" and after["videoUrl"] == before["videoUrl"]
    assert after["redosUsed"] == 0 and after["redoNotice"]
    assert after["clips"][2]["status"] == "ready"
    assert after["clips"][2]["storagePath"] == before["clips"][2]["storagePath"]
    assert world.usage("event-ev1")["redos"] == 0
    assert world.budget()["reservedUsd"] == 0
    world.script.clear()
    redo(world, wid, 2)  # it can be tried again
    assert world.svc.run("ev1", wid) == "preview"


def test_no_redo_while_running_or_published(world):
    ready(world)
    r = world.create()
    with pytest.raises(ApiError) as e:
        redo(world, r["id"])
    assert e.value.status == 409
    world.svc.run("ev1", r["id"])
    world.svc.approve(uid="host1", eid="ev1", wid=r["id"])
    with pytest.raises(ApiError) as e:
        redo(world, r["id"])
    assert e.value.status == 409


def test_redo_of_a_deleted_photo_is_refused(world):
    wid = preview(world)
    world.db.collection("events").document("ev1").collection("photos").document("p1").delete()
    with pytest.raises(ApiError) as e:
        redo(world, wid)
    assert e.value.status == 409


# ------------------------------------------------------------------ approve, unpublish, delete
def test_approve_only_from_preview(world):
    ready(world)
    r = world.create()
    with pytest.raises(ApiError):
        world.svc.approve(uid="host1", eid="ev1", wid=r["id"])
    world.svc.run("ev1", r["id"])
    assert world.svc.approve(uid="host1", eid="ev1", wid=r["id"])["status"] == "published"
    doc = world.doc("ev1", r["id"])
    assert doc["status"] == "published" and doc["publishedBy"] == "host1"


def test_unpublish_kills_the_old_link(world):
    wid = preview(world)
    world.svc.approve(uid="host1", eid="ev1", wid=wid)
    old = world.doc("ev1", wid)
    world.svc.unpublish(eid="ev1", wid=wid)
    doc = world.doc("ev1", wid)
    assert doc["status"] == "preview" and doc["videoUrl"] != old["videoUrl"] and doc["posterUrl"] != old["posterUrl"]
    assert world.svc.approve(uid="host1", eid="ev1", wid=wid)["status"] == "published"


def test_delete_removes_files_and_still_counts(world):
    wid = preview(world)
    world.svc.delete(eid="ev1", wid=wid)
    assert not world.svc.wt_ref("ev1", wid).get().exists
    assert world.storage.files(f"walkthroughs/ev1/{wid}/") == []
    assert world.usage("event-ev1")["videos"] == 1, "making and deleting can't get around the limit"
    with pytest.raises(ApiError):
        world.create(rid="again")


def test_delete_during_a_run_stops_it_and_closes_the_money(world):
    ready(world, **price())
    r = world.create()
    world.svc.delete(eid="ev1", wid=r["id"])
    assert world.budget()["reservedUsd"] == 0
    assert world.svc.run("ev1", r["id"]) == "inactive"
    assert world.usage("event-ev1")["activeJob"] is None
    assert world.provider.submitted == []


def test_delete_mid_clip_cancels_and_cleans_up(world):
    ready(world, **price())
    world.provider.polls = 3
    r = world.create()
    orig = world.provider.check
    calls = []

    def check_then_delete(ref):
        calls.append(ref)
        if len(calls) == 1:
            world.svc.delete(eid="ev1", wid=r["id"])
            world.deps.poll_seconds = 61  # the next heartbeat notices
        return orig(ref)
    world.provider.check = check_then_delete
    assert world.svc.run("ev1", r["id"]) == "cancelled"
    assert world.storage.files(f"walkthroughs/ev1/{r['id']}/") == []
    assert world.budget()["reservedUsd"] == 0
    assert world.budget()["spentUsd"] == 0.5, "the clip at the provider is assumed billed"


# ------------------------------------------------------------------ privacy of the raw clips
def test_published_doc_has_no_link_to_unlabeled_clips(world):
    wid = preview(world)
    world.svc.approve(uid="host1", eid="ev1", wid=wid)
    doc = world.doc("ev1", wid)
    urls = [v for c in doc["clips"] for v in c.values() if isinstance(v, str) and v.startswith("http")]
    assert urls == []
    assert "clipUsd" not in doc and "reservations" not in doc and "frameUrls" not in doc


def test_frames_are_cropped_to_shape_before_sending(world):
    from PIL import Image
    ready(world)
    r = world.create(aspect="16:9")
    world.svc.run("ev1", r["id"])
    frame = world.storage.root / f"walkthroughs/ev1/{r['id']}/frames/0.jpg"
    assert Image.open(frame).size == (1280, 720)

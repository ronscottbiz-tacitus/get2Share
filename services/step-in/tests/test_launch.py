"""The one-time launch change (launch.py): albums, Big Events for paid events, the backstop date."""
from datetime import datetime, timedelta, timezone

import launch
from conftest import FakeDb

LAUNCH = datetime(2026, 12, 1, 18, 0, tzinfo=timezone.utc)
DAY = timedelta(days=1)


def world():
    db = FakeDb(lambda: LAUNCH)
    return db, db.docs


def event(docs, eid, *, ends, expire="30", code=None, features=None, members=(), name=None):
    """expire: '30' = the live app's 30 days after the end; None = no date; or a datetime."""
    ev = {"name": name or eid, "endsAt": ends}
    if expire == "30":
        expire = ends + 30 * DAY
    if expire is not None:
        ev["expireAt"] = expire
    if code:
        ev["joinCode"] = code
        docs[f"joinCodes/{code}"] = {"eventId": eid, "expireAt": expire}
    docs[f"events/{eid}"] = ev
    if features is not None:
        docs[f"features/{eid}"] = features
    for uid in members:
        docs[f"events/{eid}/members/{uid}"] = {"nickname": uid, "expireAt": expire}
        docs[f"users/{uid}/joined/{eid}"] = {"name": ev["name"], "expireAt": expire}
    return ev


def go(db, live=True, **kw):
    lines = []
    r = launch.run(db, live=live, now=LAUNCH, log=lines.append, **kw)
    return r, lines


def test_a_free_album_moves_to_14_days():
    db, docs = world()
    ends = LAUNCH - 2 * DAY
    event(docs, "ev1", ends=ends, code="ABC123", members=["maya"])
    go(db)
    assert docs["events/ev1"]["expireAt"] == ends + 14 * DAY
    assert docs["joinCodes/ABC123"]["expireAt"] == ends + 14 * DAY
    assert docs["users/maya/joined/ev1"]["expireAt"] == ends + 14 * DAY


def test_no_free_album_closes_sooner_than_a_week_after_launch():
    db, docs = world()
    ends = LAUNCH - 10 * DAY  # 14 days would close it in 4
    event(docs, "ev1", ends=ends)
    go(db)
    assert docs["events/ev1"]["expireAt"] == LAUNCH + 7 * DAY


def test_and_none_stays_open_longer_than_it_would_have():
    db, docs = world()
    ends = LAUNCH - 27 * DAY  # closes in 3 days today
    event(docs, "ev1", ends=ends)
    go(db)
    assert docs["events/ev1"]["expireAt"] == ends + 30 * DAY


def test_new_7_day_events_are_left_as_they_are():
    db, docs = world()
    ends = LAUNCH + DAY
    event(docs, "ev1", ends=ends, expire=ends + 7 * DAY)
    r, _ = go(db)
    assert docs["events/ev1"]["expireAt"] == ends + 7 * DAY and r.unchanged == 1


def test_an_old_event_without_a_date_gets_one():
    db, docs = world()
    ends = LAUNCH - DAY
    event(docs, "ev1", ends=ends, expire=None)
    go(db)
    assert docs["events/ev1"]["expireAt"] == ends + 14 * DAY


def test_paid_seconds_make_a_big_event_with_a_year():
    db, docs = world()
    ends = LAUNCH - 2 * DAY
    event(docs, "ev1", ends=ends, features={"flowSeconds": 100})
    r, _ = go(db)
    f = docs["features/ev1"]
    assert f["tier"] == "big" and f["upgraded"] is True and f["flowSeconds"] == 100
    assert docs["events/ev1"]["expireAt"] == ends + 365 * DAY
    assert [x[0] for x in r.made_big] == ["ev1"]


def test_included_seconds_alone_are_not_paid_seconds():
    db, docs = world()
    ends = LAUNCH - 2 * DAY
    event(docs, "ev1", ends=ends, expire=ends + 182 * DAY,
          features={"tier": "party", "upgraded": True, "includedSeconds": 20, "flowSeconds": 20})
    r, _ = go(db)
    assert docs["features/ev1"]["tier"] == "party" and not r.made_big
    assert docs["events/ev1"]["expireAt"] == ends + 182 * DAY


def test_an_upgraded_event_never_loses_time():
    db, docs = world()
    ends = LAUNCH - 2 * DAY
    event(docs, "ev1", ends=ends, expire=ends + 400 * DAY, features={"tier": "big"})
    go(db)
    assert docs["events/ev1"]["expireAt"] == ends + 400 * DAY


def test_records_get_the_later_backstop_and_never_an_earlier_one():
    db, docs = world()
    ends = LAUNCH - 2 * DAY
    event(docs, "ev1", ends=ends)
    docs["events/ev1/photos/p1"] = {"url": "x", "expireAt": ends + 30 * DAY}
    docs["events/ev1/photos/p2"] = {"url": "y", "expireAt": ends + 1000 * DAY}
    docs["events/ev1/photos/p3"] = {"url": "z"}
    r, _ = go(db)
    closes = ends + 14 * DAY
    assert docs["events/ev1/photos/p1"]["expireAt"] == closes + 365 * DAY
    assert docs["events/ev1/photos/p2"]["expireAt"] == ends + 1000 * DAY
    assert "expireAt" not in docs["events/ev1/photos/p3"]
    assert r.records == 1


def test_left_alone_keep_no_end_and_closed():
    db, docs = world()
    event(docs, "kept", ends=LAUNCH - 40 * DAY, features={"keep": True})
    event(docs, "open", ends=None, expire=None)
    event(docs, "gone", ends=LAUNCH - 40 * DAY)
    r, _ = go(db)
    assert {x[0] for x in r.skipped} == {"kept", "open", "gone"}
    assert docs["events/gone"]["expireAt"] == LAUNCH - 10 * DAY


def test_looking_changes_nothing():
    db, docs = world()
    ends = LAUNCH - 2 * DAY
    event(docs, "ev1", ends=ends, features={"flowSeconds": 100})
    docs["events/ev1/photos/p1"] = {"url": "x", "expireAt": ends + 30 * DAY}
    before = {k: dict(v) for k, v in docs.items()}
    r, lines = go(db, live=False)
    assert docs == before
    assert r.made_big and r.moved and r.records == 1
    assert any("would become a Big Event" in x for x in lines)


def test_it_runs_only_once():
    db, docs = world()
    ends = LAUNCH - 2 * DAY
    event(docs, "ev1", ends=ends)
    go(db)
    assert docs["config/launch"]["moved"] == 1
    docs["events/ev1"]["expireAt"] = ends + 30 * DAY  # pretend something changed it back
    r, lines = go(db)
    assert docs["events/ev1"]["expireAt"] == ends + 30 * DAY and r.events == 0
    assert any("already ran" in x for x in lines)

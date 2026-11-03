from walkthrough.config import LABEL, month_key, parse_config, size_for


def test_missing_doc_is_off_and_admin_only():
    c = parse_config(None)
    assert c.enabled is False and c.all_hosts is False and c.provider is None
    assert (c.min_photos, c.max_photos, c.clip_seconds, c.free_account_seconds) == (3, 10, 5, 20)
    assert c.limits["videosPerEvent"] >= 1 and c.limits["redosPerEvent"] >= 1
    assert c.limits["videosPerHostPerMonth"] >= 1
    assert c.monthly_budget_usd == 50


def test_only_a_literal_true_turns_it_on():
    for value in ("true", 1, "yes", None):
        assert parse_config({"enabled": value, "allHosts": value}).enabled is False
        assert parse_config({"enabled": value, "allHosts": value}).all_hosts is False
    assert parse_config({"enabled": True}).enabled is True


def test_default_presets():
    c = parse_config({})
    assert [(p.id, p.photos, p.clips, p.seconds) for p in c.presets] == [("10s", 3, 2, 10.0), ("15s", 4, 3, 15.0)]
    assert c.preset(None).id == "15s"


def test_a_larger_preset_comes_from_config_alone():
    c = parse_config({"presets": [{"id": "30s", "label": "30 sec", "photos": 7, "clipSeconds": 5}], "defaultPreset": "30s"})
    p = c.preset("30s")
    assert p.photos == 7 and p.clips == 6 and p.seconds == 30
    assert c.preset("15s") is None


def test_bad_values_fall_back():
    c = parse_config({"presets": [{"id": "x", "photos": 1}, {"photos": 3}, "junk"], "limits": {"videosPerEvent": "lots"},
                      "budget": {"monthlyUsd": -5}, "resolution": "8k", "slowdown": [9, "x", 1.5], "hold": {"startSeconds": 99}})
    assert [p.id for p in c.presets] == ["10s", "15s"]
    assert c.limits["videosPerEvent"] == 3
    assert c.monthly_budget_usd == 50
    assert c.resolution == "720p"
    assert c.slowdown == (1.0, 1.0, 1.5)
    assert c.hold_start == 0


def test_prices_fail_closed_and_can_be_overridden():
    c = parse_config({"prices": {"fal": {"720p": 0.1}, "new": {"720p": 0.2}}})
    assert c.price_per_second("fal", "720p") == 0.1
    assert c.price_per_second("fal", "480p") == 0.15
    assert c.price_per_second("new", "720p") == 0.2
    assert c.price_per_second("new", "480p") is None
    assert c.price_per_second("nobody", "720p") is None
    assert parse_config({"prices": {"fal": {"720p": "free"}}}).price_per_second("fal", "720p") is None


def test_480p_is_configurable():
    assert parse_config({"resolution": "480p"}).resolution == "480p"
    assert size_for("9:16", "720p") == (720, 1280)
    assert size_for("16:9", "480p") == (854, 480)


def test_month_key_is_utc():
    assert month_key(1_790_000_000.0) == "2026-09"


def test_label_words():
    assert LABEL == "AI-generated video. Some moments and details aren't real."

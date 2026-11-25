"""Buying passes with Stripe Checkout, with a fake Stripe. Nothing here touches the network."""
import json

import pytest
from fastapi.testclient import TestClient

from walkthrough.api import build_api
from walkthrough.billing import Billing, return_checker
from walkthrough.config import parse_config
from walkthrough.service import ApiError

ORIGINS = ["https://share.get2.one", "http://localhost:3000"]
REGEX = r"https://get2-?share-[a-z0-9-]+\.vercel\.app"
RETURN = "https://share.get2.one/host/ev1"


class FakeStripe:
    """Stands in for the stripe module: checkout.Session.create and Webhook.construct_event."""
    def __init__(self):
        self.sessions = []
        outer = self

        class Session:
            @staticmethod
            def create(**kw):
                outer.sessions.append(kw)
                return {"id": f"cs_test_{len(outer.sessions)}", "url": f"https://checkout.stripe.test/{len(outer.sessions)}"}

        class Checkout:
            pass
        Checkout.Session = Session
        self.checkout = Checkout

        class Webhook:
            @staticmethod
            def construct_event(payload, signature, secret):
                if signature != f"signed-with-{secret}":
                    raise ValueError("bad signature")
                return json.loads(payload)
        self.Webhook = Webhook


def make(world, *, key="sk_test_abc", whsec="whsec_abc", checkout=True, **config):
    world.configure(checkout=checkout, **config)
    stripe = FakeStripe()
    b = Billing(db=world.db, run_tx=world.svc.d.run_tx, stripe=stripe, secret_key=key, webhook_secret=whsec,
                config=lambda: parse_config(world.db.collection("config").document("walkthrough").get().to_dict()),
                return_ok=return_checker(ORIGINS, REGEX), server_time="now", log=lambda *_: None)
    return b, stripe


def paid(session_id="cs_test_1", eid="ev1", seconds="100", plan="flowPass", status="paid", kind="checkout.session.completed"):
    return json.dumps({"type": kind, "livemode": False, "data": {"object": {
        "id": session_id, "payment_status": status, "amount_total": 1500, "currency": "usd",
        "customer_details": {"email": "host@example.com"},
        "metadata": {"eventId": eid, "planId": plan, "seconds": seconds, "uid": "host1"}}}}).encode()


def flow_seconds(world, eid="ev1"):
    snap = world.db.collection("features").document(eid).get()
    return (snap.to_dict() or {}).get("flowSeconds") if snap.exists else None


# ------------------------------------------------------------------ who sees Buy buttons
def test_test_keys_show_checkout_to_admins_only(world):
    b, _ = make(world)
    assert b.offer(real_admin=True) == {"checkout": True, "checkoutTest": True}
    assert b.offer(real_admin=False) == {"checkout": False, "checkoutTest": False}


def test_live_keys_show_checkout_to_every_host(world):
    b, _ = make(world, key="sk_live_abc")
    assert b.offer(real_admin=False) == {"checkout": True, "checkoutTest": False}


@pytest.mark.parametrize("kw", [{"checkout": False}, {"key": ""}, {"whsec": ""}])
def test_checkout_stays_off_without_the_switch_or_both_keys(world, kw):
    b, _ = make(world, **kw)
    assert b.offer(real_admin=True)["checkout"] is False
    with pytest.raises(ApiError) as e:
        b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="flowPass", return_url=RETURN)
    assert e.value.status == 403


# ------------------------------------------------------------------ starting a checkout
def test_a_checkout_charges_the_pass_price_for_this_event(world):
    b, stripe = make(world)
    r = b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={"name": "Sam's 40th"}, plan_id="flowPassPlus", return_url=RETURN)
    assert r == {"url": "https://checkout.stripe.test/1"}
    s = stripe.sessions[0]
    assert s["mode"] == "payment" and s["api_key"] == "sk_test_abc"
    item = s["line_items"][0]
    assert item["price_data"]["unit_amount"] == 2900 and item["price_data"]["currency"] == "usd"
    assert item["price_data"]["product_data"]["name"] == "Flow Pass Plus: 200 seconds of Flow"
    assert "Sam's 40th" in item["price_data"]["product_data"]["description"]
    assert s["metadata"] == {"eventId": "ev1", "planId": "flowPassPlus", "seconds": "200", "uid": "host1"}
    assert s["success_url"] == RETURN + "?pass=done&session={CHECKOUT_SESSION_ID}"
    assert s["cancel_url"] == RETURN + "?pass=cancelled"


def test_a_changed_price_in_config_is_what_gets_charged(world):
    b, stripe = make(world, plans={"flowPass": {"usd": 12, "seconds": 120}})
    b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="flowPass", return_url=RETURN)
    assert stripe.sessions[0]["line_items"][0]["price_data"]["unit_amount"] == 1200
    assert stripe.sessions[0]["metadata"]["seconds"] == "120"


@pytest.mark.parametrize("plan", ["pro", "nope", ""])
def test_only_event_passes_are_for_sale(world, plan):
    b, _ = make(world)
    with pytest.raises(ApiError) as e:
        b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id=plan, return_url=RETURN)
    assert e.value.status == 400


@pytest.mark.parametrize("url,ok", [
    ("https://share.get2.one/host/ev1", True),
    ("https://get2-share-git-stripe-checkout-get22.vercel.app/host/ev1", True),
    ("http://localhost:3000/host/ev1", True),
    ("https://evil.example/host/ev1", False),
    ("https://share.get2.one.evil.example/x", False),
    ("https://user@share.get2.one/x", False),
    ("javascript:alert(1)", False),
])
def test_checkout_only_returns_to_the_apps_own_pages(world, url, ok):
    b, _ = make(world)
    if ok:
        b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="flowPass", return_url=url)
    else:
        with pytest.raises(ApiError) as e:
            b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="flowPass", return_url=url)
        assert e.value.status == 400


# ------------------------------------------------------------------ Stripe calling back
def test_a_bad_signature_adds_nothing(world):
    b, _ = make(world)
    with pytest.raises(ApiError) as e:
        b.handle_webhook(paid(), "forged")
    assert e.value.status == 400
    assert flow_seconds(world) is None


def test_a_paid_checkout_adds_its_seconds_once(world):
    b, _ = make(world)
    assert b.handle_webhook(paid(), "signed-with-whsec_abc") == {"ok": True, "added": True}
    assert flow_seconds(world) == 100
    assert b.handle_webhook(paid(), "signed-with-whsec_abc") == {"ok": True, "added": False}, "Stripe resends; no double"
    assert flow_seconds(world) == 100
    record = world.db.collection("flowPurchases").document("cs_test_1").get().to_dict()
    assert record["eventId"] == "ev1" and record["seconds"] == 100 and record["amountUsd"] == 15 and record["email"] == "host@example.com"


def test_passes_stack_and_keep_what_the_event_had(world):
    b, _ = make(world)
    world.db.collection("features").document("ev1").set({"flowSeconds": 5, "pro": True})
    b.handle_webhook(paid("cs_test_1"), "signed-with-whsec_abc")
    b.handle_webhook(paid("cs_test_2", seconds="200", plan="flowPassPlus"), "signed-with-whsec_abc")
    feat = world.db.collection("features").document("ev1").get().to_dict()
    assert feat == {"flowSeconds": 305, "pro": True}


def test_an_unpaid_or_unrelated_notice_adds_nothing(world):
    b, _ = make(world)
    assert "waiting" in b.handle_webhook(paid(status="unpaid"), "signed-with-whsec_abc")
    assert "ignored" in b.handle_webhook(paid(kind="customer.created"), "signed-with-whsec_abc")
    assert flow_seconds(world) is None


def test_a_slow_payment_adds_seconds_when_it_clears(world):
    b, _ = make(world)
    b.handle_webhook(paid(kind="checkout.session.async_payment_succeeded"), "signed-with-whsec_abc")
    assert flow_seconds(world) == 100


def test_paid_seconds_show_on_the_meter(world):
    b, _ = make(world)
    world.add_event()
    b.handle_webhook(paid(), "signed-with-whsec_abc")
    m = world.svc.meter(uid="host1", eid="ev1")
    assert (m["plan"], m["allowanceSeconds"], m["canRemoveEndCard"]) == ("event", 100, True)


# ------------------------------------------------------------------ the app checking back
def test_status_says_when_the_seconds_are_in(world):
    b, _ = make(world)
    assert b.status(eid="ev1", session_id="cs_test_1") == {"done": False}
    b.handle_webhook(paid(), "signed-with-whsec_abc")
    assert b.status(eid="ev1", session_id="cs_test_1") == {"done": True, "seconds": 100, "planId": "flowPass"}
    assert b.status(eid="other", session_id="cs_test_1") == {"done": False}, "only for the event it was bought for"
    with pytest.raises(ApiError):
        b.status(eid="ev1", session_id="../../config/walkthrough")


# ------------------------------------------------------------------ the web endpoints
def verify(token, event_id):
    if token == "cohost":
        return "cohost1", {"name": "Party", "ownerUid": "host1", "flowCohosts": True}, False
    return ("admin1" if token == "admin" else "host1"), {"name": "Party", "ownerUid": "host1"}, token == "admin"


@pytest.fixture
def client(world):
    b, stripe = make(world, key="sk_live_abc")
    world.add_event()
    c = TestClient(build_api(lambda: world.svc, verify, origins=ORIGINS, origin_regex=REGEX, billing_factory=lambda: b))
    return world, c, stripe


def test_the_owner_can_start_a_checkout_and_a_cohost_cannot(client):
    world, c, stripe = client
    body = {"eventId": "ev1", "planId": "flowPass", "returnUrl": RETURN}
    r = c.post("/checkout", json=body, headers={"Authorization": "Bearer host"})
    assert r.status_code == 200 and r.json()["url"].startswith("https://checkout.stripe.test/")
    r = c.post("/checkout", json=body, headers={"Authorization": "Bearer cohost"})
    assert r.status_code == 403 and "owner" in r.json()["detail"]
    assert c.post("/checkout", json=body).status_code == 401


def test_the_meter_says_whether_to_show_buy_buttons(client):
    world, c, _ = client
    m = c.post("/meter", json={"eventId": "ev1"}, headers={"Authorization": "Bearer host"}).json()
    assert m["checkout"] is True and m["checkoutTest"] is False


def test_the_webhook_needs_stripes_signature_not_a_sign_in(client):
    world, c, _ = client
    assert c.post("/stripe/webhook", content=paid(), headers={"Stripe-Signature": "forged"}).status_code == 400
    r = c.post("/stripe/webhook", content=paid(), headers={"Stripe-Signature": "signed-with-whsec_abc"})
    assert r.status_code == 200 and r.json()["added"] is True
    assert flow_seconds(world) == 100
    s = c.post("/checkout/status", json={"eventId": "ev1", "sessionId": "cs_test_1"}, headers={"Authorization": "Bearer host"})
    assert s.json() == {"done": True, "seconds": 100, "planId": "flowPass"}


def test_without_billing_the_app_gets_the_email_fallback(world):
    world.configure()
    world.add_event()
    c = TestClient(build_api(lambda: world.svc, verify, origins=ORIGINS, origin_regex=REGEX))
    m = c.post("/meter", json={"eventId": "ev1"}, headers={"Authorization": "Bearer host"}).json()
    assert m["checkout"] is False
    r = c.post("/checkout", json={"eventId": "ev1", "planId": "flowPass", "returnUrl": RETURN}, headers={"Authorization": "Bearer host"})
    assert r.status_code == 403


# ------------------------------------------------------------------ keys pasted wrong, Stripe saying no
def test_a_key_pasted_with_spaces_or_quotes_still_works(world):
    b, stripe = make(world, key=' "sk_test_abc" \n', whsec=" whsec_abc ")
    assert b.offer(real_admin=True) == {"checkout": True, "checkoutTest": True}
    b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="flowPass", return_url=RETURN)
    assert stripe.sessions[0]["api_key"] == "sk_test_abc"
    b.handle_webhook(paid(), "signed-with-whsec_abc")
    assert flow_seconds(world) == 100


def test_the_publishable_key_turns_checkout_off(world):
    b, _ = make(world, key="pk_test_abc")
    assert b.offer(real_admin=True)["checkout"] is False


def test_any_key_that_isnt_live_is_treated_as_test(world):
    b, _ = make(world, key="something_else")
    assert b.offer(real_admin=False)["checkout"] is False
    assert b.offer(real_admin=True) == {"checkout": True, "checkoutTest": True}


def test_when_stripe_says_no_the_host_sees_why(world):
    b, stripe = make(world)

    class StripeError(Exception):
        user_message = "Invalid API Key provided: sk_test_****abc"

    def refuse(**kw):
        raise StripeError("401")
    stripe.checkout.Session.create = staticmethod(refuse)
    with pytest.raises(ApiError) as e:
        b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="flowPass", return_url=RETURN)
    assert e.value.status == 502 and "Invalid API Key" in e.value.message


def test_a_broken_checkout_still_answers_the_app(world):
    world.configure()
    world.add_event()

    def broken():
        raise RuntimeError("stripe library missing")
    c = TestClient(build_api(lambda: world.svc, verify, origins=ORIGINS, origin_regex=REGEX, billing_factory=broken))
    r = c.post("/checkout", json={"eventId": "ev1", "planId": "flowPass", "returnUrl": RETURN}, headers={"Authorization": "Bearer host"})
    assert r.status_code == 502 and "Checkout" in r.json()["detail"]


# ------------------------------------------------------------------ the real Stripe library
def real_signed(payload: bytes, secret: str):
    import hashlib
    import hmac
    import time
    ts = int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def test_a_real_stripe_signed_notice_adds_the_seconds(world):
    """With the real stripe library: its objects aren't dicts, which the fake hid."""
    import stripe as real_stripe
    world.configure(checkout=True)
    b = Billing(db=world.db, run_tx=world.svc.d.run_tx, stripe=real_stripe, secret_key="sk_test_abc", webhook_secret="whsec_real",
                config=lambda: parse_config(world.db.collection("config").document("walkthrough").get().to_dict()),
                return_ok=return_checker(ORIGINS, REGEX), server_time="now", log=lambda *_: None)
    body = paid(seconds="200", plan="flowPassPlus")
    assert b.handle_webhook(body, real_signed(body, "whsec_real")) == {"ok": True, "added": True}
    assert flow_seconds(world) == 200
    with pytest.raises(ApiError):
        b.handle_webhook(body, real_signed(body, "whsec_wrong"))


# ------------------------------------------------------------------ Party and Big Event
def upgrade_paid(session_id="cs_test_u1", eid="ev1", tier="big", seconds="100", step_up=False):
    plan = {"party": "party", "big": "bigEvent"}[tier]
    body = json.loads(paid(session_id, eid, seconds=seconds, plan=plan))
    body["data"]["object"]["metadata"]["tier"] = tier
    if step_up:
        body["data"]["object"]["metadata"]["stepUp"] = "1"
    return json.dumps(body).encode()


def features(world, eid="ev1"):
    return world.db.collection("features").document(eid).get().to_dict()


def offered(world, eid="ev1", real_admin=True):
    return {p["id"]: p for p in world.svc.meter(uid="host1", eid=eid, real_admin=real_admin)["plans"]}


def test_party_and_big_event_lead_the_price_list(world):
    make(world, upgrade=True)
    plans = world.svc.meter(uid="host1", eid="ev1")["plans"]
    assert plans[0] == {"id": "party", "name": "Party", "usd": 10, "seconds": 20, "per": "event", "tier": "party"}
    assert plans[1] == {"id": "bigEvent", "name": "Big Event", "usd": 29, "seconds": 100, "per": "event", "tier": "big"}
    assert world.svc.meter(uid="host1", eid="ev1")["tier"] == "free"


def test_until_the_upgrades_are_on_sale_only_admins_see_or_buy_them(world):
    """So the service can ship before the app that sells them: the live app would list them as passes."""
    b, stripe = make(world, key="sk_live_abc")  # live keys: every host can buy passes
    assert list(offered(world, real_admin=False)) == ["flowPass", "flowPassPlus", "pro"]
    assert list(offered(world))[:2] == ["party", "bigEvent"]
    for plan in ("party", "bigEvent"):
        with pytest.raises(ApiError) as e:
            b.create_checkout(uid="host1", real_admin=False, eid="ev1", event={}, plan_id=plan, return_url=RETURN)
        assert e.value.status == 400
    assert not stripe.sessions
    b.create_checkout(uid="host1", real_admin=False, eid="ev1", event={}, plan_id="flowPass", return_url=RETURN)
    b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="party", return_url=RETURN)
    world.configure(checkout=True, upgrade=True)
    assert list(offered(world, real_admin=False))[:2] == ["party", "bigEvent"]
    b.create_checkout(uid="host2", real_admin=False, eid="ev2", event={}, plan_id="bigEvent", return_url=RETURN)
    assert len(stripe.sessions) == 3


def test_each_checkout_says_what_it_upgrades(world):
    b, stripe = make(world)
    b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={"name": "Sam's 40th"}, plan_id="party", return_url=RETURN)
    b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={"name": "Sam's 40th"}, plan_id="bigEvent", return_url=RETURN)
    party, big = stripe.sessions
    pp, bp = (s["line_items"][0]["price_data"] for s in (party, big))
    assert pp["unit_amount"] == 1000 and pp["product_data"]["name"] == "Party upgrade, with 20 seconds of Flow"
    assert "Sam's 40th" in pp["product_data"]["description"] and "up to 100 guests" in pp["product_data"]["description"]
    assert bp["unit_amount"] == 2900 and bp["product_data"]["name"] == "Big Event upgrade, with 100 seconds of Flow"
    assert "unlimited guests" in bp["product_data"]["description"] and "one-year album" in bp["product_data"]["description"]
    assert party["metadata"]["tier"] == "party" and big["metadata"]["tier"] == "big"
    assert "stepUp" not in big["metadata"]


def test_party_adds_its_seconds_but_keeps_the_end_card(world):
    b, _ = make(world)
    world.add_event()
    b.handle_webhook(upgrade_paid(tier="party", seconds="20"), "signed-with-whsec_abc")
    feat = features(world)
    assert feat["tier"] == "party" and feat["upgraded"] is True and feat["flowSeconds"] == 20 and feat["includedSeconds"] == 20
    m = world.svc.meter(uid="host1", eid="ev1")
    assert m["tier"] == "party" and m["allowanceSeconds"] == 20 and m["canRemoveEndCard"] is False
    assert "party" not in offered(world)
    with pytest.raises(ApiError) as e:
        b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="party", return_url=RETURN)
    assert e.value.status == 400 and "already has" in e.value.message
    # A Flow Pass on top is a pass: the end card can go.
    b.handle_webhook(paid("cs_test_p2"), "signed-with-whsec_abc")
    assert world.svc.meter(uid="host1", eid="ev1")["canRemoveEndCard"] is True


def test_party_to_big_event_costs_the_difference(world):
    b, stripe = make(world)
    world.add_event()
    b.handle_webhook(upgrade_paid(tier="party", seconds="20"), "signed-with-whsec_abc")
    big = offered(world)["bigEvent"]
    assert big["usd"] == 19 and big["seconds"] == 80 and big["stepUp"] is True
    b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={"name": "Sam's 40th"}, plan_id="bigEvent", return_url=RETURN)
    s = stripe.sessions[0]
    assert s["line_items"][0]["price_data"]["unit_amount"] == 1900
    assert s["line_items"][0]["price_data"]["product_data"]["name"] == "Big Event upgrade (from Party), with 80 more seconds of Flow"
    assert s["metadata"]["seconds"] == "80" and s["metadata"]["stepUp"] == "1" and s["metadata"]["tier"] == "big"
    b.handle_webhook(upgrade_paid("cs_test_u2", tier="big", seconds="80", step_up=True), "signed-with-whsec_abc")
    feat = features(world)
    assert feat["tier"] == "big" and feat["flowSeconds"] == 100 and feat["includedSeconds"] == 100
    m = world.svc.meter(uid="host1", eid="ev1")
    assert m["tier"] == "big" and m["canRemoveEndCard"] is True
    assert not {"party", "bigEvent"} & set(offered(world))
    assert b.status(eid="ev1", session_id="cs_test_u2")["planId"] == "bigEvent"


def test_big_event_on_top_of_a_flow_pass(world):
    b, _ = make(world)
    world.add_event()
    world.db.collection("features").document("ev1").set({"flowSeconds": 100})  # a Flow Pass bought earlier
    assert world.svc.meter(uid="host1", eid="ev1")["upgraded"] is False, "a Flow Pass alone doesn't upgrade"
    assert offered(world)["bigEvent"]["usd"] == 29, "a pass isn't Party: no discount"
    b.handle_webhook(upgrade_paid(), "signed-with-whsec_abc")
    feat = features(world)
    assert feat["tier"] == "big" and feat["flowSeconds"] == 200 and feat["upgradedAt"] == "now"
    m = world.svc.meter(uid="host1", eid="ev1")
    assert m["upgraded"] is True and m["allowanceSeconds"] == 200 and m["canRemoveEndCard"] is True


def test_an_event_never_moves_down_a_tier(world):
    """Two checkouts opened before either was paid: Big Event, then Party, both go through."""
    b, _ = make(world)
    b.handle_webhook(upgrade_paid(), "signed-with-whsec_abc")
    b.handle_webhook(upgrade_paid("cs_test_u2", tier="party", seconds="20"), "signed-with-whsec_abc")
    assert features(world)["tier"] == "big" and features(world)["flowSeconds"] == 120
    with pytest.raises(ApiError):
        b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="bigEvent", return_url=RETURN)
    with pytest.raises(ApiError):
        b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="party", return_url=RETURN)
    b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="flowPassPlus", return_url=RETURN)


def test_pro_events_are_big_events(world):
    b, _ = make(world)
    world.add_event()
    world.db.collection("features").document("ev1").set({"pro": True})
    assert world.svc.meter(uid="host1", eid="ev1")["tier"] == "big"
    with pytest.raises(ApiError):
        b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="party", return_url=RETURN)


def test_upgrade_prices_can_change_in_config(world):
    b, stripe = make(world, plans={"party": {"usd": 12, "seconds": 30}, "bigEvent": {"usd": 39, "seconds": 150}})
    b.create_checkout(uid="host1", real_admin=True, eid="ev1", event={}, plan_id="bigEvent", return_url=RETURN)
    assert stripe.sessions[0]["line_items"][0]["price_data"]["unit_amount"] == 3900
    assert stripe.sessions[0]["metadata"]["seconds"] == "150"
    b.handle_webhook(upgrade_paid("cs_test_u2", eid="ev2", tier="party", seconds="30"), "signed-with-whsec_abc")
    big = offered(world, eid="ev2")["bigEvent"]
    assert big["usd"] == 27 and big["seconds"] == 120

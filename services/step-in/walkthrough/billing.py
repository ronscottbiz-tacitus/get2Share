"""Buying Flow seconds with Stripe Checkout.

A host taps a pass in the Host Console. POST /checkout makes a Checkout Session for that pass and
event, and the app sends the host to Stripe's page to pay. When the payment goes through, Stripe
calls POST /stripe/webhook. That call is checked against the webhook secret, and only then are the
pass's seconds added to features/{eventId}.flowSeconds. Each payment adds its seconds once, however
many times Stripe sends the notice: flowPurchases/{sessionId} records it.

Keys live in the Modal secret get2share-stripe: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
Checkout is offered only when both are set and config/walkthrough.checkout is true. With test keys
(sk_test_ / rk_test_) it is offered to admins only, so real hosts never land on a test page.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timedelta
from typing import Any, Callable
from urllib.parse import urlsplit

from .config import Config
from .service import TIERS, ApiError, event_tier, offered_plans

PURCHASES = "flowPurchases"
PAID_EVENTS = ("checkout.session.completed", "checkout.session.async_payment_succeeded")
MSG_CLOSED = "Buying passes isn't open yet. Tap the pass to email us instead."
MSG_NOT_FOR_SALE = "That pass isn't for sale here."
MSG_BAD_RETURN = "This page can't start a checkout."
MSG_ALREADY_UPGRADED = "This event already has that upgrade."
# How long the album stays after the end, by plan. Same as ALBUM_DAYS in src/events.ts.
ALBUM_DAYS = {"free": 7, "party": 182, "big": 365}
# What each upgrade does, on Stripe's page and the receipt.
TIER_ABOUT = {
    "party": "up to 100 guests, 3 Share Spots and 3 TVs, a six-month album",
    "big": "unlimited guests, 5 Share Spots and 5 TVs, a one-year album, no branding",
}


def _dict(snap) -> dict:
    return (snap.to_dict() or {}) if snap.exists else {}


def _whole(x):
    return int(x) if float(x).is_integer() else x


def _seconds(value) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def with_params(url: str, params: str) -> str:
    """Adds query text as is, so Stripe's {CHECKOUT_SESSION_ID} placeholder stays unencoded."""
    return f"{url}{'&' if '?' in url else '?'}{params}"


class Billing:
    def __init__(self, *, db, run_tx: Callable, stripe: Any, secret_key: str | None, webhook_secret: str | None,
                 config: Callable[[], Config], return_ok: Callable[[str], bool], server_time: Any = None,
                 now: Callable = time.time, log: Callable = print):
        self.db, self.run_tx, self.stripe = db, run_tx, stripe
        # Pasted keys often carry a space or quotes; Stripe would reject them.
        self.secret_key = (secret_key or "").strip().strip('"\'').strip()
        self.webhook_secret = (webhook_secret or "").strip().strip('"\'').strip()
        self.config, self.return_ok = config, return_ok
        self.server_time, self.now, self.log = server_time, now, log

    # -------------------------------------------------------------- who sees checkout
    @property
    def test_mode(self) -> bool:
        # Anything but a live secret key counts as test: admins only. A wrong key can't reach real hosts.
        return not self.secret_key.startswith(("sk_live_", "rk_live_"))

    def available(self, real_admin: bool) -> bool:
        if not (self.secret_key and self.webhook_secret):
            return False
        if self.secret_key.startswith("pk_"):  # the publishable key can't make a checkout
            self.log("STRIPE_SECRET_KEY holds the publishable key (pk_…); it needs the secret key (sk_…)")
            return False
        if not self.config().checkout:
            return False
        return bool(real_admin) or not self.test_mode

    def offer(self, real_admin: bool) -> dict:
        """What the meter tells the app: whether to show Buy buttons, and whether they're test ones."""
        on = self.available(real_admin)
        return {"checkout": on, "checkoutTest": on and self.test_mode}

    # -------------------------------------------------------------- starting a checkout
    def create_checkout(self, *, uid: str, real_admin: bool, eid: str, event: dict | None, plan_id: str,
                        return_url: str) -> dict:
        if not self.available(real_admin):
            raise ApiError(403, MSG_CLOSED)
        cfg = self.config()
        plan = next((p for p in cfg.plans if p["id"] == plan_id), None)
        if not plan or plan.get("per") != "event":
            raise ApiError(400, MSG_NOT_FOR_SALE)
        if not self.return_ok(return_url):
            raise ApiError(400, MSG_BAD_RETURN)
        tier = plan.get("tier")
        if tier:
            if tier not in TIERS or not (cfg.upgrade or real_admin):  # not on sale yet
                raise ApiError(400, MSG_NOT_FOR_SALE)
            have = event_tier(_dict(self.db.collection("features").document(eid).get()))
            plan = next((p for p in offered_plans(cfg.plans, have) if p["id"] == plan_id), None)
            if not plan:
                raise ApiError(400, MSG_ALREADY_UPGRADED)
        cents = int(round(float(plan["usd"]) * 100))
        seconds = plan["seconds"]
        seconds_text = int(seconds) if float(seconds).is_integer() else seconds
        name = str((event or {}).get("name") or "your event")[:80]
        metadata = {"eventId": eid, "planId": plan["id"], "seconds": str(seconds), "uid": uid}
        if tier:
            metadata["tier"] = tier
            if plan.get("stepUp"):
                metadata["stepUp"] = "1"
        try:
            session = self._create_session(cents, plan, seconds_text, name, eid, metadata, return_url)
        except ApiError:
            raise
        except Exception as e:  # Stripe said no: a bad key, an account setting, a network hiccup
            msg = getattr(e, "user_message", None) or str(e) or e.__class__.__name__
            self.log(f"Checkout for {eid} failed at Stripe: {e!r}")
            raise ApiError(502, f"Stripe couldn't start the checkout: {msg}"[:300])
        return {"url": session["url"] if isinstance(session, dict) else session.url}

    def _create_session(self, cents, plan, seconds_text, name, eid, metadata, return_url):
        if metadata.get("tier") in TIER_ABOUT:
            more = " more" if metadata.get("stepUp") else ""
            title = f"{plan['name']} upgrade{' (from Party)' if metadata.get('stepUp') else ''}, with {seconds_text}{more} seconds of Flow"
            about = f'Upgrades "{name}" on Get2Share: {TIER_ABOUT[metadata["tier"]]}'
        else:
            title = f"{plan['name']}: {seconds_text} seconds of Flow"
            about = f'AI video seconds for "{name}" on Get2Share'
        return self.stripe.checkout.Session.create(
            api_key=self.secret_key,
            mode="payment",
            line_items=[{
                "quantity": 1,
                "price_data": {
                    "currency": "usd",
                    "unit_amount": cents,
                    "product_data": {"name": title, "description": about},
                },
            }],
            client_reference_id=eid,
            metadata=metadata,
            payment_intent_data={"metadata": metadata, "description": f"{plan['name']} for {name}"},
            success_url=with_params(return_url, "pass=done&session={CHECKOUT_SESSION_ID}"),
            cancel_url=with_params(return_url, "pass=cancelled"),
        )

    # -------------------------------------------------------------- Stripe calling back
    def handle_webhook(self, payload: bytes, signature: str) -> dict:
        if not self.webhook_secret:
            raise ApiError(503, "Webhooks aren't set up.")
        try:
            self.stripe.Webhook.construct_event(payload, signature, self.webhook_secret)
            # Signed by Stripe. Read it as plain data: the library's objects aren't dicts.
            event = json.loads(payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload)
        except Exception:  # a bad signature or a body that isn't Stripe's
            raise ApiError(400, "That didn't come from Stripe.")
        kind = event.get("type")
        if kind not in PAID_EVENTS:
            return {"ok": True, "ignored": kind}
        session = event["data"]["object"]
        if session.get("payment_status") != "paid":
            return {"ok": True, "waiting": session.get("id")}  # a slower payment method; its own notice follows
        added = self.fulfil(session, livemode=bool(event.get("livemode")))
        return {"ok": True, "added": added}

    def fulfil(self, session: dict, *, livemode: bool) -> bool:
        """Adds the pass's seconds to the event, once per payment. True if this call added them."""
        sid = session.get("id")
        md = session.get("metadata") or {}
        eid, seconds = md.get("eventId"), _seconds(md.get("seconds"))
        if not sid or not isinstance(eid, str) or not eid or seconds is None:
            self.log(f"Checkout {sid}: missing event or seconds, nothing added: {md}")
            return False
        purchase_ref = self.db.collection(PURCHASES).document(sid)
        features_ref = self.db.collection("features").document(eid)
        details = session.get("customer_details") or {}

        def tx_fulfil(tx):
            if purchase_ref.get(transaction=tx).exists:
                return False
            feat = _dict(features_ref.get(transaction=tx))
            had = feat.get("flowSeconds")
            had = had if isinstance(had, (int, float)) and not isinstance(had, bool) and had > 0 else 0
            total = had + seconds
            new_feat = {**feat, "flowSeconds": int(total) if float(total).is_integer() else total}
            tier = md.get("tier")
            if tier in TIERS[1:]:
                # Never down a tier. Included seconds aren't a Flow Pass (see can_remove_end_card).
                have = event_tier(feat)
                included = feat.get("includedSeconds")
                included = included if isinstance(included, (int, float)) and not isinstance(included, bool) else 0
                new_feat.update(tier=max(have, tier, key=TIERS.index), upgraded=True, upgradedAt=self.server_time,
                                includedSeconds=_whole(included + seconds))
            tx.set(features_ref, new_feat)
            tx.set(purchase_ref, {
                "eventId": eid,
                "planId": md.get("planId"),
                "seconds": seconds,
                "uid": md.get("uid"),
                "amountUsd": (session.get("amount_total") or 0) / 100,
                "currency": session.get("currency"),
                "email": details.get("email"),
                "livemode": livemode,
                "createdAt": self.server_time,
            })
            return True

        added = self.run_tx(tx_fulfil)
        self.log(f"Checkout {sid}: {'added' if added else 'already had'} {seconds} seconds on {eid}")
        if md.get("tier") in TIERS[1:]:
            try:
                self.extend_album(eid)
            except Exception as e:  # the payment is in; the album date can be fixed by hand
                self.log(f"Checkout {sid}: couldn't move {eid}'s album date: {e!r}")
        return added

    def extend_album(self, eid: str) -> None:
        """An upgraded event's album stays open longer (ALBUM_DAYS). Moves the closing date
        (expireAt) on the event, its join code and each guest's "my events" entry. Never earlier.
        Records inside the event already carry a later backstop date (see ttlFrom in src/events.ts)."""
        event_ref = self.db.collection("events").document(eid)
        ev = _dict(event_ref.get())
        ends = ev.get("endsAt")
        if not isinstance(ends, datetime):
            return  # no end time: nothing closes
        days = ALBUM_DAYS[event_tier(_dict(self.db.collection("features").document(eid).get()))]
        closes = ends + timedelta(days=days)
        current = ev.get("expireAt")
        if isinstance(current, datetime) and current >= closes:
            return
        event_ref.update({"expireAt": closes})
        code = ev.get("joinCode")
        if isinstance(code, str) and code:
            code_ref = self.db.collection("joinCodes").document(code)
            if code_ref.get().exists:
                code_ref.update({"expireAt": closes})
        for member in event_ref.collection("members").stream():
            joined = self.db.collection("users").document(member.id).collection("joined").document(eid)
            if joined.get().exists:
                joined.update({"expireAt": closes})
        self.log(f"{eid}: album now open until {closes:%Y-%m-%d}")

    # -------------------------------------------------------------- the app checking back
    def status(self, *, eid: str, session_id: str) -> dict:
        """After Stripe sends the host back: have this payment's seconds landed yet?"""
        if not re.fullmatch(r"cs_[A-Za-z0-9_]{1,250}", session_id or ""):
            raise ApiError(400, "That isn't a checkout.")
        snap = self.db.collection(PURCHASES).document(session_id).get()
        data = _dict(snap)
        if not data or data.get("eventId") != eid:
            return {"done": False}
        return {"done": True, "seconds": data.get("seconds"), "planId": data.get("planId")}


def return_checker(origins: list[str], origin_regex: str | None) -> Callable[[str], bool]:
    """Checkout may only send hosts back to the app's own pages: share.get2.one, its previews, local."""
    pattern = re.compile(origin_regex) if origin_regex else None

    def ok(url: str) -> bool:
        if not isinstance(url, str) or len(url) > 2000:
            return False
        parts = urlsplit(url)
        if parts.scheme not in ("https", "http") or not parts.netloc or parts.username or parts.password:
            return False
        origin = f"{parts.scheme}://{parts.netloc}"
        return origin in origins or bool(pattern and pattern.fullmatch(origin))

    return ok

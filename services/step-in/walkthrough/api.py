"""The web endpoints the app calls. Every one checks the Firebase sign-in and that the caller hosts
the event. Whether the feature is on for this person is checked inside Service.

Making or redoing a video spends AI seconds, so those two are for the event's owner. The owner can
let co-hosts do it too by turning on flowCohosts on the event (Host Console, Co-hosts)."""

MSG_OWNER_ONLY = ("Only this event's owner can make or redo Flow videos. "
                  "The owner can let co-hosts do it in the Host Console, under Co-hosts.")


def may_spend(uid: str, event: dict | None, is_admin: bool) -> bool:
    """The owner, an admin, or any host once the owner has switched co-hosts on."""
    e = event or {}
    return bool(is_admin) or e.get("ownerUid") == uid or e.get("flowCohosts") is True

from typing import Callable


MSG_OWNER_BUYS = "Only this event's owner can buy passes for it."


def build_api(service_factory: Callable, verify: Callable, *, origins: list[str], origin_regex: str | None = None,
              billing_factory: Callable | None = None):
    """verify(id_token, event_id) -> (uid, event, is_admin), (uid, event, is_admin, grant_seconds) or
    (uid, event, is_admin, grant_seconds, real_admin), raising PermissionError with a message the
    app can show. is_admin opens the feature (an invited host counts); real_admin is a Get2Share
    admin and nothing less. Without it, is_admin stands in."""
    from fastapi import FastAPI, Header, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel

    from .service import ApiError

    web = FastAPI(title="Get2Share Walkthrough")
    web.add_middleware(CORSMiddleware, allow_origins=origins, allow_origin_regex=origin_regex,
                       allow_methods=["POST", "OPTIONS"], allow_headers=["Authorization", "Content-Type"])

    def signed_in(authorization: str, event_id: str):
        token = authorization.removeprefix("Bearer ").strip()
        if not token:
            raise HTTPException(401, "Sign in first.")
        try:
            uid, event, is_admin, grant, real_admin = (*verify(token, event_id), None, None)[:5]
        except PermissionError as e:
            raise HTTPException(403, str(e))
        return uid, event, is_admin, grant, (is_admin if real_admin is None else real_admin)

    def spender(authorization: str, event_id: str):
        uid, event, is_admin, grant, real_admin = signed_in(authorization, event_id)
        if not may_spend(uid, event, real_admin):
            raise HTTPException(403, MSG_OWNER_ONLY)
        return uid, event, is_admin, grant

    def answering(fn):
        try:
            return fn()
        except ApiError as e:
            raise HTTPException(e.status, e.message)

    class Create(BaseModel):
        eventId: str
        photoIds: list[str]
        presetId: str | None = None
        aspect: str
        acceptedNotice: bool = False
        noticeVersion: int = 0
        requestId: str
        showLabel: bool = True
        styleId: str | None = None
        endCard: bool = True

    class Redo(BaseModel):
        eventId: str
        walkthroughId: str
        clipIndex: int

    class One(BaseModel):
        eventId: str
        walkthroughId: str

    class Label(BaseModel):
        eventId: str
        walkthroughId: str
        show: bool

    class Meter(BaseModel):
        eventId: str

    class Checkout(BaseModel):
        eventId: str
        planId: str
        returnUrl: str

    class CheckoutStatus(BaseModel):
        eventId: str
        sessionId: str

    @web.post("/create")
    def create(req: Create, authorization: str = Header(default="")):
        uid, event, is_admin, grant = spender(authorization, req.eventId)
        return answering(lambda: service_factory().create(
            uid=uid, is_admin=is_admin, eid=req.eventId, event=event, photo_ids=req.photoIds, preset_id=req.presetId,
            aspect=req.aspect, accepted_notice=req.acceptedNotice, notice_version=req.noticeVersion,
            request_id=req.requestId, show_label=req.showLabel, grant_seconds=grant, style_id=req.styleId,
            end_card=req.endCard))

    @web.post("/redo")
    def redo(req: Redo, authorization: str = Header(default="")):
        uid, _, is_admin, grant = spender(authorization, req.eventId)
        return answering(lambda: service_factory().redo(
            uid=uid, is_admin=is_admin, eid=req.eventId, wid=req.walkthroughId, clip_index=req.clipIndex, grant_seconds=grant))

    @web.post("/label")
    def label(req: Label, authorization: str = Header(default="")):
        uid, _, is_admin, grant, _ = signed_in(authorization, req.eventId)
        return answering(lambda: service_factory().set_label(
            uid=uid, is_admin=is_admin, eid=req.eventId, wid=req.walkthroughId, show=req.show, grant_seconds=grant))

    @web.post("/meter")
    def meter(req: Meter, authorization: str = Header(default="")):
        uid, _, is_admin, grant, real_admin = signed_in(authorization, req.eventId)
        m = answering(lambda: service_factory().meter(uid=uid, eid=req.eventId, is_admin=is_admin, grant_seconds=grant))
        # Whether the app shows Buy buttons (Stripe Checkout) or the email fallback.
        return {**m, **(billing_factory().offer(real_admin) if billing_factory else {"checkout": False, "checkoutTest": False})}

    # ---- Buying passes (walkthrough/billing.py)
    @web.post("/checkout")
    def checkout(req: Checkout, authorization: str = Header(default="")):
        uid, event, _, _, real_admin = signed_in(authorization, req.eventId)
        if not billing_factory:
            raise HTTPException(403, "Buying passes isn't open yet.")
        if not (real_admin or (event or {}).get("ownerUid") == uid):
            raise HTTPException(403, MSG_OWNER_BUYS)
        return answering(lambda: billing_factory().create_checkout(
            uid=uid, real_admin=real_admin, eid=req.eventId, event=event, plan_id=req.planId, return_url=req.returnUrl))

    @web.post("/checkout/status")
    def checkout_status(req: CheckoutStatus, authorization: str = Header(default="")):
        signed_in(authorization, req.eventId)
        if not billing_factory:
            return {"done": False}
        return answering(lambda: billing_factory().status(eid=req.eventId, session_id=req.sessionId))

    @web.post("/stripe/webhook")
    async def stripe_webhook(request: Request, stripe_signature: str = Header(default="")):
        # No sign-in here: Stripe calls this, and the signature check in billing is the guard.
        if not billing_factory:
            raise HTTPException(503, "Webhooks aren't set up.")
        payload = await request.body()
        return answering(lambda: billing_factory().handle_webhook(payload, stripe_signature))

    @web.post("/approve")
    def approve(req: One, authorization: str = Header(default="")):
        uid, _, _, _, _ = signed_in(authorization, req.eventId)
        return answering(lambda: service_factory().approve(uid=uid, eid=req.eventId, wid=req.walkthroughId))

    @web.post("/unpublish")
    def unpublish(req: One, authorization: str = Header(default="")):
        signed_in(authorization, req.eventId)
        return answering(lambda: service_factory().unpublish(eid=req.eventId, wid=req.walkthroughId))

    @web.post("/delete")
    def delete(req: One, authorization: str = Header(default="")):
        signed_in(authorization, req.eventId)
        return answering(lambda: service_factory().delete(eid=req.eventId, wid=req.walkthroughId))

    @web.get("/health")
    def health():
        return {"ok": True}

    return web

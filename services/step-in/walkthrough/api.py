"""The web endpoints the app calls. Every one checks the Firebase sign-in and that the caller hosts
the event. Whether the feature is on for this person is checked inside Service."""

from typing import Callable


def build_api(service_factory: Callable, verify: Callable, *, origins: list[str], origin_regex: str | None = None):
    """verify(id_token, event_id) -> (uid, event, is_admin), raising PermissionError with a
    message the app can show."""
    from fastapi import FastAPI, Header, HTTPException
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
            return verify(token, event_id)
        except PermissionError as e:
            raise HTTPException(403, str(e))

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

    class Redo(BaseModel):
        eventId: str
        walkthroughId: str
        clipIndex: int

    class One(BaseModel):
        eventId: str
        walkthroughId: str

    @web.post("/create")
    def create(req: Create, authorization: str = Header(default="")):
        uid, event, is_admin = signed_in(authorization, req.eventId)
        return answering(lambda: service_factory().create(
            uid=uid, is_admin=is_admin, eid=req.eventId, event=event, photo_ids=req.photoIds, preset_id=req.presetId,
            aspect=req.aspect, accepted_notice=req.acceptedNotice, notice_version=req.noticeVersion,
            request_id=req.requestId))

    @web.post("/redo")
    def redo(req: Redo, authorization: str = Header(default="")):
        uid, _, is_admin = signed_in(authorization, req.eventId)
        return answering(lambda: service_factory().redo(
            uid=uid, is_admin=is_admin, eid=req.eventId, wid=req.walkthroughId, clip_index=req.clipIndex))

    @web.post("/approve")
    def approve(req: One, authorization: str = Header(default="")):
        uid, _, _ = signed_in(authorization, req.eventId)
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

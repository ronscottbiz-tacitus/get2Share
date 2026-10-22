"""
Get2Share Step In, running on Modal (serverless GPU, billed per second).

  POST /request   the app asks for a Step In moment for one photo (hosts only)
  StepIn.make     the GPU job: photo -> Step In + Step Out splats -> Firebase
  nightly_cleanup deletes expired events (reports only until STEP_IN_CLEANUP=delete)

Deploy:   modal deploy modal_app.py
Try one:  modal run modal_app.py::make_one --event-id EVENT --photo-id PHOTO
Preview cleanup:  modal run modal_app.py::cleanup_now
"""

import os
import tempfile
import time
from pathlib import Path

import modal

APP_NAME = "get2share-step-in"
SECRET = modal.Secret.from_name("get2share-firebase")
ALLOWED_ORIGINS = ["https://share.get2.one", "https://get2-share.vercel.app",
                   "http://localhost:3000", "http://127.0.0.1:3000"]
ALLOWED_ORIGIN_REGEX = r"https://get2-?share-[a-z0-9-]+\.vercel\.app"  # Vercel preview links

app = modal.App(APP_NAME)
STALE_SECONDS = 300  # a job silent this long is treated as dead and can be requested again


def _bake_models():
    from stepin.pipeline import download_all
    download_all()


gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "curl", "libgl1", "libglib2.0-0")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        "npm install -g @playcanvas/splat-transform@3.8.0",
    )
    .pip_install("torch==2.8.0", "torchvision==0.23.0", index_url="https://download.pytorch.org/whl/cu128")
    .pip_install(
        "moge @ git+https://github.com/microsoft/MoGe.git@925b8ed",
        # onnxruntime-gpu 1.26 is the last CUDA 12.8 build, matching torch cu128 (1.27+ needs CUDA 13)
        "rembg==2.0.86", "onnxruntime-gpu==1.26.*",
        "pymatting", "scipy", "pillow", "pillow-heif", "requests",
        "firebase-admin==7.7.0",
    )
    .env({"HF_HOME": "/models/hf", "TORCH_HOME": "/models/torch", "U2NET_HOME": "/models/rembg"})
    .add_local_python_source("stepin", copy=True)
    .run_function(_bake_models)
    .env({"HF_HUB_OFFLINE": "1"})  # models are baked in; skip the check for updates
)

web_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]", "firebase-admin==7.7.0", "requests")
    .add_local_python_source("stepin")
)


# ------------------------------------------------------------------ GPU job
@app.cls(gpu="L4", image=gpu_image, secrets=[SECRET], timeout=600, scaledown_window=300, max_containers=4)
class StepIn:
    @modal.enter()
    def load(self):
        from stepin.pipeline import Models, Settings
        self.models = Models(settings=Settings())

    @modal.method()
    def make(self, event_id: str, photo_id: str) -> dict:
        from stepin import firebase_io as fb
        from stepin.pipeline import compress, make_moment, write_ply

        started = time.perf_counter()
        print(f"Step In started: event {event_id} photo {photo_id}")
        fb.set_status(event_id, photo_id, status="processing", error=None)
        try:
            img = fb.load_photo(event_id, photo_id)
            m = make_moment(img, self.models)
            result = {"people": m.people, "inFrame": m.in_frame, "outFrame": m.out_frame,
                      "timings": m.timings, "version": 1}
            with tempfile.TemporaryDirectory() as tmp:
                for kind, splats in (("in", m.step_in), ("out", m.step_out)):
                    if splats is None:
                        result[f"{kind}Url"] = None
                        continue
                    raw = Path(tmp) / f"{kind}.ply"
                    n = write_ply(raw, splats)
                    # .sog is ~6x smaller than compressed .ply and loads faster on phones and TVs.
                    final = raw
                    for small in (Path(tmp) / f"{kind}.sog", Path(tmp) / f"{kind}.compressed.ply"):
                        if compress(raw, small):
                            final = small
                            break
                    remote = f"moments/{event_id}/{photo_id}-{kind}{''.join(final.suffixes)}"
                    result[f"{kind}Url"] = fb.upload(str(final), remote)
                    result[f"{kind}Splats"] = n
                    result[f"{kind}Bytes"] = final.stat().st_size
            result["seconds"] = round(time.perf_counter() - started, 1)
            fb.set_status(event_id, photo_id, status="ready", **result)
            return result
        except Exception as e:
            fb.set_status(event_id, photo_id, status="failed", error=_friendly(e))
            raise


def _friendly(e: Exception) -> str:
    msg = str(e)
    if isinstance(e, FileNotFoundError):
        return msg
    if "depth" in msg.lower():
        return "This photo didn't work for Step In. Try one with people closer to the camera."
    return "Step In didn't finish for this photo. Try again in a minute."


# ------------------------------------------------------------------ request endpoint
@app.function(image=web_image, secrets=[SECRET])
@modal.asgi_app()
def api():
    from fastapi import FastAPI, Header, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel

    from stepin import firebase_io as fb

    web = FastAPI(title="Get2Share Step In")
    web.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_origin_regex=ALLOWED_ORIGIN_REGEX,
                       allow_methods=["POST", "OPTIONS"], allow_headers=["Authorization", "Content-Type"])

    class Req(BaseModel):
        eventId: str
        photoId: str
        redo: bool = False

    @web.post("/request")
    def request_step_in(req: Req, authorization: str = Header(default="")):
        from firebase_admin import firestore
        token = authorization.removeprefix("Bearer ").strip()
        if not token:
            raise HTTPException(401, "Sign in first.")
        try:
            uid, _ = fb.verify_host(token, req.eventId)
        except PermissionError as e:
            raise HTTPException(403, str(e))
        snap = fb.photo_ref(req.eventId, req.photoId).get()
        if not snap.exists:
            raise HTTPException(404, "That photo was deleted.")
        current = (snap.to_dict() or {}).get("stepIn") or {}
        status = current.get("status")
        updated = current.get("updatedAt")
        stale = updated is None or (time.time() - updated.timestamp()) > STALE_SECONDS
        # A job that's been "queued" or "processing" for too long died; let it start over.
        if (status in ("queued", "processing") and not stale) or (status == "ready" and not req.redo):
            return {"status": status}
        fb.photo_ref(req.eventId, req.photoId).update({"stepIn": {
            "status": "queued", "requestedBy": uid,
            "requestedAt": firestore.SERVER_TIMESTAMP, "updatedAt": firestore.SERVER_TIMESTAMP,
        }})
        # Look the GPU job up by name, so this works from the deployed web container.
        call = modal.Cls.from_name(APP_NAME, "StepIn")().make.spawn(req.eventId, req.photoId)
        print(f"Step In queued: event {req.eventId} photo {req.photoId} call {call.object_id}")
        return {"status": "queued"}

    @web.get("/health")
    def health():
        return {"ok": True}

    return web


# ------------------------------------------------------------------ cleanup
@app.function(image=web_image, secrets=[SECRET], timeout=1800, schedule=modal.Cron("17 11 * * *"))
def nightly_cleanup():
    """Runs daily at 11:17 UTC (4:17 am Pacific)."""
    from stepin import firebase_io as fb
    fb.cleanup(live=os.environ.get("STEP_IN_CLEANUP") == "delete")


@app.function(image=web_image, secrets=[SECRET], timeout=1800)
def cleanup_now(live: bool = False):
    from stepin import firebase_io as fb
    return fb.cleanup(live=live)


# ------------------------------------------------------------------ manual test
@app.local_entrypoint()
def make_one(event_id: str, photo_id: str):
    print(StepIn().make.remote(event_id, photo_id))

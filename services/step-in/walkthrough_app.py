"""
Get2Share AI Walkthrough, running on Modal. No GPU: the video AI runs at an outside service, and
this app sends the frames, collects the clips and joins them with ffmpeg.

  POST /create, /redo, /approve, /unpublish, /delete   called by the app, hosts only
  run_walkthrough                                      the job; continues if the host leaves
  sweep                                                restarts stuck jobs, clears deleted events

This is its own Modal app, so deploying it can't disturb Step In or Step In's nightly cleanup.
Setup is in WALKTHROUGH.md.

Deploy:  modal deploy walkthrough_app.py
"""
from pathlib import Path

import modal

APP_NAME = "get2share-walkthrough"
FIREBASE_SECRET = modal.Secret.from_name("get2share-firebase")
PROVIDER_SECRET = modal.Secret.from_name("get2share-walkthrough-providers")
# STRIPE_SECRET_KEY, and STRIPE_WEBHOOK_SECRET once the webhook exists (WALKTHROUGH.md, Buying passes).
STRIPE_SECRET = modal.Secret.from_name("get2share-stripe")
ALLOWED_ORIGINS = ["https://share.get2.one", "https://get2-share.vercel.app",
                   "http://localhost:3000", "http://127.0.0.1:3000"]
ALLOWED_ORIGIN_REGEX = r"https://get2-?share-[a-z0-9-]+\.vercel\.app"  # Vercel preview links

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.12")
    # Debian's ffmpeg has drawtext; the font is the one the label is burned in with.
    .apt_install("ffmpeg", "fonts-dejavu-core")
    .pip_install("fastapi[standard]", "firebase-admin==7.7.0", "requests", "pillow", "stripe==17.1.0")
    .add_local_python_source("stepin", "walkthrough")
    # The brand fonts for the end card (walkthrough/media.py looks for them here).
    .add_local_dir(Path(__file__).parent / "walkthrough" / "fonts", "/root/walkthrough_fonts")
)


def _service():
    from walkthrough.runtime import service

    def spawn(eid: str, wid: str):
        modal.Function.from_name(APP_NAME, "run_walkthrough").spawn(eid, wid)
    return service(spawn)


@app.function(image=image, secrets=[FIREBASE_SECRET, PROVIDER_SECRET], timeout=3600, cpu=2.0, memory=2048)
def run_walkthrough(event_id: str, walkthrough_id: str) -> str:
    """Generates the clips and joins them. A clip takes minutes, so this outlives the request."""
    result = _service().run(event_id, walkthrough_id)
    print(f"Walkthrough {event_id}/{walkthrough_id}: {result}")
    return result


@app.function(image=image, secrets=[FIREBASE_SECRET, PROVIDER_SECRET, STRIPE_SECRET])
@modal.asgi_app()
def api():
    from stepin import firebase_io as fb
    from walkthrough.api import build_api
    from walkthrough.runtime import billing, flow_access

    def verify(token: str, event_id: str):
        uid, event, is_admin = fb.verify_event_host(token, event_id, denied="Only hosts can make Flow videos.")
        # An invited host gets the same access as an admin to this feature, and nothing else.
        invited, grant = flow_access(token)
        # The fifth value is the real admin flag: an invite opens the feature, it doesn't make a
        # co-host the owner (see may_spend in walkthrough/api.py).
        return uid, event, is_admin or invited, grant, is_admin

    return build_api(_service, verify, origins=ALLOWED_ORIGINS, origin_regex=ALLOWED_ORIGIN_REGEX,
                     billing_factory=lambda: billing(ALLOWED_ORIGINS, ALLOWED_ORIGIN_REGEX))


@app.function(image=image, secrets=[FIREBASE_SECRET, PROVIDER_SECRET], timeout=600, schedule=modal.Cron("*/15 * * * *"))
def sweep():
    print(_service().sweep())

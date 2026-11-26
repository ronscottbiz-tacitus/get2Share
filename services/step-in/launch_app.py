"""
Runs the one-time launch change (launch.py) on Modal, with the Firebase key from the
get2share-firebase secret. Nothing is deployed; it runs once and stops.

From services/step-in:
  ~/.modal-venv/bin/modal run launch_app.py            look only: lists what would change
  ~/.modal-venv/bin/modal run launch_app.py --live     make the changes
"""
import modal

app = modal.App("get2share-launch")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("firebase-admin==7.7.0", "requests", "pillow")
    .add_local_python_source("stepin", "walkthrough", "launch")
)


@app.function(image=image, secrets=[modal.Secret.from_name("get2share-firebase")], timeout=3600)
def change(live: bool, again: bool) -> None:
    import launch
    from stepin import firebase_io as fb
    launch.run(fb.db(), live=live, again=again)


@app.local_entrypoint()
def main(live: bool = False, again: bool = False):
    change.remote(live, again)

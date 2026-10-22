# Step In (cloud job)

Turns one event photo into two 3D moments:

- **Step In**: the whole scene. The background behind the people is filled in, so the photo opens up when the camera sways.
- **Step Out**: just the people, as a floating cutout.

Hosts of Pro events request it per photo. The GPU job writes the files to Firebase Storage under `moments/<eventId>/` and updates the photo's `stepIn` field. The app (step 2, not built yet) listens for that field and shows the moment.

Every model used allows commercial use:

| Step | Model | License |
|---|---|---|
| Depth and lens | MoGe-2 (Microsoft) | MIT |
| Find every person | Mask R-CNN (torchvision) | BSD-3 |
| Fine cutout edges | BiRefNet, via rembg | MIT |
| Fill in behind people | LaMa | Apache 2.0 |

## What's here

| File | What it does |
|---|---|
| `stepin/pipeline.py` | The pipeline itself. Same code runs in the cloud and on a Mac. |
| `stepin/cli.py` | Run it on your own computer, on a folder of photos. |
| `stepin/firebase_io.py` | Firebase reads and writes, the host check, and the expired-event cleanup. |
| `modal_app.py` | The cloud side: request endpoint, GPU job, nightly cleanup. |

## Data written to each photo

`events/{eventId}/photos/{photoId}.stepIn`:

| Field | Meaning |
|---|---|
| `status` | `queued`, `processing`, `ready` or `failed` |
| `inUrl`, `outUrl` | Download links for the Step In and Step Out splats (compressed .ply). `outUrl` is null when no people were found. |
| `inFrame`, `outFrame` | Framing hints for the viewer: `pivot` (orbit depth), `cx`/`cy` (view center as x/z, y/z), `tanH`/`tanV` (extent). Files are saved upright: y up, original camera at the origin looking down +z. |
| `people` | How many people were found |
| `inBytes`, `outBytes`, `inSplats`, `outSplats`, `seconds`, `timings` | Size and speed, for tuning |
| `error` | A message the app can show when `status` is `failed` |

## Who can use it

The request endpoint checks that the caller signed in, hosts the event, and that the event has `pro: true`. The admin accounts in `STEP_IN_ADMIN_EMAILS` (the same two as `storage.rules`) can use it on any event they host, for testing. There's no paid plan in the app yet, so for now set `pro: true` on an event in the Firebase console.

## Set up (one time)

1. **Make a Modal account** at modal.com. It bills per second of GPU use, and nothing runs while idle.
2. **Install the Modal tool on your Mac** and sign in:
   ```bash
   cd ~/Projects/get2Share-live/services/step-in
   uv venv --python 3.12 && source .venv/bin/activate
   uv pip install modal
   modal setup
   ```
3. **Get a Firebase key for the cloud job.** Firebase console → Project settings → Service accounts → **Generate new private key**. That downloads a JSON file. It has full access to the project, so keep it private.
4. **Give the key to Modal**, then delete the downloaded file:
   ```bash
   modal secret create get2share-firebase \
     FIREBASE_SERVICE_ACCOUNT="$(cat ~/Downloads/get2share-*.json)" \
     FIREBASE_STORAGE_BUCKET=get2share.firebasestorage.app
   rm ~/Downloads/get2share-*.json
   ```
5. **Deploy:**
   ```bash
   modal deploy modal_app.py
   ```
   The first deploy builds the image and downloads every model into it, which takes about 10–15 minutes. Modal prints the web address for `api`. The app will need it in step 2.

## Try it on one photo

Find an event ID and a photo ID in the Firebase console (Firestore → events → your event → photos), then:

```bash
modal run modal_app.py::make_one --event-id EVENT_ID --photo-id PHOTO_ID
```

The first run in a while waits about a minute for the GPU to start and load the models. After that, each photo takes a few seconds, and the GPU stays warm for 5 minutes. When it finishes, the photo's `stepIn` field shows `ready` with two links. Paste a link into 3D Moments Lab's file picker (download it first) to look at it.

## Cleanup of expired events

`nightly_cleanup` runs every day at 4:17 am Pacific. It finds events past their album date (the same rule the app uses) and deletes their photos, Step In files, every record under the event, and the join code.

**It only reports until you turn it on.** To see what it would delete:

```bash
modal run modal_app.py::cleanup_now
```

To keep an event forever (a demo event, say), set `keep: true` on it in the Firebase console. When the report looks right, turn on real deletes by adding `STEP_IN_CLEANUP=delete` to the secret:

```bash
modal secret create --force get2share-firebase \
  FIREBASE_SERVICE_ACCOUNT="…same as before…" \
  FIREBASE_STORAGE_BUCKET=get2share.firebasestorage.app \
  STEP_IN_CLEANUP=delete
```

## Run it on your Mac instead

```bash
cd ~/Projects/get2Share-live/services/step-in
source .venv/bin/activate
uv pip install -r requirements-local.txt
python -m stepin.cli -i ~/Projects/splatlab/sharp-in2 -o ~/Projects/splatlab/stepin-out --debug
```

You get `<name>-in.ply` and `<name>-out.ply`, plus smaller `.compressed.ply` copies when Node is installed. Add `--birefnet birefnet-general-lite` if it runs out of memory, or `--cutout subject` to cut out the main object instead of people.

## Cost

An L4 GPU on Modal costs well under a cent per photo of processing. The 5 minutes it stays warm after a burst costs a few cents. Stored files are about 3–8 MB per photo, and they're deleted with the event once cleanup is on.

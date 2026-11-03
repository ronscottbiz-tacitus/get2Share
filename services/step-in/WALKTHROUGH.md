# AI Walkthrough videos: setup for Ron

A host picks a few photos. An outside AI video service animates from each photo to the next. The cloud job joins the clips into one silent video with this burned in: **"AI-generated video. Some moments and details aren't real."** The host previews it, can redo a clip, and approves it. Only then does it reach the gallery and the TVs.

**Status: Next, on the `ai-walkthrough` branch. Not live.** Nothing here has run on Modal or called a real video service. It stays off until you do the steps below, and it spends nothing until step 6.

## What only you can do, in order

### 1. Run the rules tests on your Mac

These couldn't run where this was built, so **they have never been run**. Do this before step 2. Java must be installed.

```bash
cd ~/Projects/get2Share-live
git fetch && git checkout ai-walkthrough
npm install
npm i --no-save firebase-tools @firebase/rules-unit-testing@5
for t in walkthrough step-in guest-lens; do
  npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/$t.test.mjs" || break
done
```

Each one ends with "All ... rules checks passed." If you see FAIL, stop there.

To also try the job against real Firestore transactions, including many hosts racing for the same budget (also never run yet):

```bash
cd services/step-in
uv venv --python 3.12 .venv-test && source .venv-test/bin/activate
uv pip install -r requirements-test.txt
cd ../..
npx firebase emulators:exec --only firestore --project demo-get2share \
  "cd services/step-in && python -m pytest tests/test_walkthrough_emulator.py -v"
```

### 2. Publish the Firestore rules

Firebase console → Firestore → Rules → paste in `firestore.rules` → **Publish**.

The change only adds to what's there: `events/{id}/walkthroughs`, and `config/walkthrough` becomes readable. The live site keeps working. **`storage.rules` doesn't change**, so don't publish it. It already blocks the app from writing or reading these files.

### 3. Add the Modal secret

`get2share-firebase` already exists and gets reused. Add one more, with the fake provider for now:

```bash
cd ~/Projects/get2Share-live/services/step-in
source .venv/bin/activate
modal secret create get2share-walkthrough-providers WALKTHROUGH_PROVIDER=fake
```

The fake provider just fades one photo into the next. It costs nothing and sends nothing outside.

### 4. Deploy the new Modal app

```bash
modal deploy walkthrough_app.py
```

This is its own app, `get2share-walkthrough`. It can't disturb Step In or its nightly cleanup. There's no GPU. Modal prints the web address for `api`. If it isn't exactly `https://ronscottbiz-tacitus--get2share-walkthrough-api.us-east.modal.run`, set `VITE_WALKTHROUGH_API` to what it printed in Vercel (Preview environment) and redeploy the preview.

It runs a small check every 15 minutes, which restarts stuck jobs and clears files from deleted events. That's a few seconds of CPU each time.

### 5. Turn it on for admins and do a dry run

The preview uses your real Firebase project, so this config is live data. It's safe because only admins get access and the live site has no Walkthrough screens yet.

Firebase console → Firestore → collection `config` → add document `walkthrough`:

| Field | Type | Value |
|---|---|---|
| `enabled` | boolean | `true` |
| `allHosts` | boolean | `false` |
| `provider` | string | `fake` |

Open the preview link signed in as an admin. Host Console → **Walkthrough video**. Make one, leave the page and come back, redo a clip, approve it, check the gallery on a phone and on a TV, save it, take it down, delete it.

The limits apply to you too, so use a new event or raise `limits` (below) if you hit one. Check on a real iPhone and a real TV: the screenshots came from a browser that can't play H.264, so playing the actual MP4 on those devices hasn't been tested.

### 6. Connect a real video service (this is where money starts)

The three adapters in `walkthrough/providers.py` (`higgsfield`, `fal`, `veo`) were written from notes and **have never talked to the real services**. They refuse to run until you opt in. For the one you choose:

1. Read its current API docs and compare them with the adapter: the fields sent, the status names, where the video link is, and how it reports a refused photo. Also confirm it really does accept a start frame and an end frame, and that it allows 5-second clips. Veo in particular may not.
2. Look up the **real price** and put it in `config/walkthrough` (see `prices` below). The built-in prices are guesses. The monthly cap is only as good as these numbers.
3. Add the key, replacing the secret:
   ```bash
   modal secret create --force get2share-walkthrough-providers \
     WALKTHROUGH_ALLOW_UNVERIFIED=1 \
     FAL_KEY="..." FAL_MODEL="owner/model-name"
   ```
   The keys are `HIGGSFIELD_API_KEY` plus `HIGGSFIELD_MODEL_PATH`, `FAL_KEY` plus `FAL_MODEL`, or `GEMINI_API_KEY` plus `VEO_MODEL`. Never put a key in the repo.
4. Redeploy so the job sees it: `modal deploy walkthrough_app.py`
5. Set `provider` in `config/walkthrough` to that service, and start with a low `budget.monthlyUsd`, like `5`.
6. Make one 10-second video. Check the service's own usage page against what you expected. Try a photo with faces, since the refusal handling is untested on real services too.
7. Once it's right, set `verified = True` on that adapter in code and remove `WALKTHROUGH_ALLOW_UNVERIFIED`.

### 7. When you're ready for it to go live

Tell Claude to merge to `main`. Nothing goes live without you. Later, set `allHosts` to `true` to open it to every host.

## Optional: hide Step In

This is ready but not switched on. Once this branch is on `main`, in `config/stepIn` set `allHosts` to `false`. Existing moments stop showing to guests and on TVs, and warm-ups stop, including for admins. Admins keep the Make button for testing. Nothing changes for anyone until you flip it. On the current live site that switch only hides the button, so don't count on it hiding moments before this is merged.

## Optional: cleanup

The nightly cleanup in the Step In app now also deletes `walkthroughs/{eventId}/`, but that only takes effect when you next deploy `modal_app.py`. Don't deploy it during an event: the first start afterward is slow. You don't need to rush, since the Walkthrough app's own 15-minute check also clears these files once an event is gone.

## config/walkthrough settings

Everything is optional except `enabled`. A missing document means off for everyone, admins included.

| Field | Default | What it does |
|---|---|---|
| `enabled` | off | The off switch. Off also stops a running job before its next clip. |
| `allHosts` | off | Off: admins only. On: every host. |
| `provider` | none | `fake`, `higgsfield`, `fal` or `veo`. Falls back to `WALKTHROUGH_PROVIDER`. With neither, hosts are told it isn't set up. |
| `model` | none | The provider's model name or path. |
| `resolution` | `720p` | Or `480p`. |
| `limits.videosPerEvent` | 1 | Videos per event. A failed or refused one isn't counted. A deleted one is. |
| `limits.redosPerEvent` | 2 | Redos per event. A redo that fails isn't counted. |
| `limits.videosPerHostPerMonth` | 3 | Per person, because anyone with a Google account can make unlimited events. |
| `limits.redosPerHostPerMonth` | 6 | Same idea. |
| `budget.monthlyUsd` | 50 | Across all hosts. Money is set aside before each clip is sent. At the cap, hosts see a friendly message. |
| `prices.<provider>.<resolution>` | estimates | US dollars per generated second. No price means it refuses to run. |
| `presets` | 10 sec, 15 sec | A list of `{id, label, photos, clipSeconds}`. A larger video is just another row: `{id: "30s", label: "30 sec", photos: 7, clipSeconds: 5}`. This list replaces the defaults. |
| `defaultPreset` | `15s` | Which one is picked first. |
| `slowdown` | none | Per clip, like `[1.5, 1, 1]`. Plays that clip slower. The cost doesn't change. Up to 4. |
| `hold.startSeconds`, `hold.endSeconds`, `hold.zoom` | 0, 0, off | Non-AI seconds on the first and last photo, with an optional slow zoom. Up to 5 seconds each. |
| `prompt` | a careful default | What the AI is asked to do. |

This document is readable by anyone signed in, as with `config/stepIn`, so don't put anything private in it.

Spending is in `walkthroughUsage/global-YYYY-MM` (`reservedUsd`, `spentUsd`). When it can't tell whether a clip was billed, it counts it as spent, so this can read a little high. It's an estimate from your price table. The provider's own bill is the real number. Reservations and limits work from what's in Firestore, so they keep working even if the app is closed.

## How it behaves

- **Leaving the page:** the job runs in the cloud. Progress shows when the host returns. There are no notifications.
- **A refused photo** (faces, content rules): a friendly message, no retry, nothing counted. The host picks different photos. This assumes services don't bill refused clips, which needs checking against your provider's terms.
- **Temporary failures:** one automatic retry. If that fails too, the host can tap Try again. Finished clips are kept and not paid for again.
- **A crashed job:** the 15-minute check restarts it. It skips finished clips, and a clip still at the service is checked on, not re-sent. If the worker died in the instant of sending, it can't tell, so it counts that as spent and sends again. That one case can cost one extra clip.
- **Redo:** only that clip is regenerated. If it fails, the host keeps the video they had.
- **Taking it down:** back to host-only, with a new file link so old links stop working. Anyone who already saved it keeps their copy.
- **Delete:** removes the record and files for good. The video still counts toward the limit.
- **Saving:** guests can save it unless the host set album saving to "Only me" or "After it ends", in which case the same rule as for the album applies.
- **Photos deleted later:** deleting a photo doesn't change a video already made from it. The host has to take the video down.
- **Where it plays on a TV:** once when approved, then every 5 minutes. A paused TV doesn't play it.

## Running the tests here

```bash
cd services/step-in
python -m pytest tests            # about 6 minutes, needs ffmpeg and tesseract. No network, no cost.
```

Screens, from the repo root, with the harness running (see `harness/README.md`): `node harness/walkthrough-shots.mjs <out-dir>`.

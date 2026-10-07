# Get2Share

Live event photo sharing with remote camera triggers: guests snap and share from their phones, stationary Share Spots (phones or tablets on a stand) fire on command, and the host can borrow a guest's lens for a group shot.

A React + Vite web app backed by Firebase (Firestore, Storage, Auth). Originally prototyped in Google AI Studio; now maintained here on GitHub.

## Run locally

Prerequisite: Node.js

1. `npm install`
2. `npm run dev`

## Security model

Get2Share runs many events at once, each sealed off from the others.

- **Routes:** `/` landing (join by code or host your own) · `/e/CODE` an event's join link · `/host` sign in, your events, create one · `/host/EVENTID` Host Console · `/spot` set up a Share Spot.
- **Guests and Share Spots** sign in silently with Firebase **anonymous** auth; the uid is their ID.
- **Hosts** sign in with **Google**. Anyone with an account can create an event and becomes its owner and host. `adminEmails()` in `firestore.rules` (mirrored in `src/hosts.ts`) can help with any event.
- **Data:** `events/{id}` with `members`, `photos`, `sessions`, `live/console` under it; `joinCodes/{CODE}` maps a code to its event; `spotPairings/{CODE}` are one-time Share Spot codes tied to one event.
- `firestore.rules` enforces it server-side:
  - You only see an event's photos if you joined it with its current join code, or host it.
  - Only that event's hosts moderate, change settings, see devices and previews, ask for cameras, fire shutters, or add Share Spots.
  - A guest photo goes live immediately only if auto-approval is on, or a host fired that device's shutter in the last 2 minutes. Otherwise it is `pending`.
  - A host can make a new join link at any time; the old one stops working, and people already in stay in.
  - Share Spots join only by claiming a one-time code from the Host Console (claimed within 10 minutes, once).
- `storage.rules`: each device uploads only into `photos/<its uid>/`, images up to 5 MB.

## One-time Firebase setup

In the [Firebase console](https://console.firebase.google.com/) for the app's project (configured in `src/firebase-config.ts`):

1. **Authentication → Sign-in method**: enable **Anonymous** and **Google**.
2. **Authentication → Settings → Authorized domains**: add the site's domain (and any preview domain you test on).
3. **Firestore → Rules**: paste in `firestore.rules` and click **Publish** whenever that file changes.
4. **Storage → CORS** (once): lets the app read photo files so guests can save them to their devices
   ("Save to this device", "Save all"). In Google Cloud Shell, upload `cors.json` and run:
   `gcloud storage buckets update gs://get2share.firebasestorage.app --cors-file=cors.json`.
   Without it, saving falls back to opening the photo so the guest can press and hold it.

## Changing hosts

Edit the email list in both `firestore.rules` and `src/hosts.ts`, then redeploy the rules.

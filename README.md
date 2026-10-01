# Get2Share

Live event photo sharing with remote camera triggers: guests snap and share from their phones, stationary "tripod" phones fire on command, and the host can borrow a guest's lens for a group shot.

A React + Vite web app backed by Firebase (Firestore, Storage, Auth). Originally prototyped in Google AI Studio; now maintained here on GitHub.

## Run locally

Prerequisite: Node.js

1. `npm install`
2. `npm run dev`

## Security model

- **Guests and tripods** sign in silently with Firebase **anonymous** auth. Their Firebase uid is their session ID.
- **The host** signs in with **Google**. Only the emails listed in `firestore.rules` (`hostEmails()`) get host powers. `src/hosts.ts` mirrors that list for the UI. Keep them identical.
- `firestore.rules` enforces everything server-side:
  - Only the host can approve/reject photos, change settings, read other devices' sessions and camera previews, invite lenses, or fire shutters.
  - Guests can create only their own session and photos, react (±1), and flag. They can delete only their own photos.
  - A guest photo goes live immediately only if auto-approval is on, or the host fired that device's shutter in the last 2 minutes. Otherwise it is `pending`.

## One-time Firebase setup

In the [Firebase console](https://console.firebase.google.com/) for the app's project (configured in `src/firebase-config.ts`):

1. **Authentication → Sign-in method**: enable **Anonymous** and **Google**.
2. **Authentication → Settings → Authorized domains**: add the site's domain (and any preview domain you test on).
3. **Firestore → Rules**: paste in `firestore.rules` and click **Publish** whenever that file changes.

## Changing hosts

Edit the email list in both `firestore.rules` and `src/hosts.ts`, then redeploy the rules.

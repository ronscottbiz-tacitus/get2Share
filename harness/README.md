# Screenshot harness

Runs Get2Share with a fake Firebase (`harness/stubs/`), so any screen can be captured
at any size without touching the real database.

```
npm i --no-save playwright @fontsource-variable/archivo @fontsource-variable/plus-jakarta-sans @fontsource-variable/jetbrains-mono
./node_modules/.bin/vite --config vite.harness.config.mjs   # http://localhost:5199
node harness/example-shots.mjs                               # from the repo root
```

Chromium is preinstalled at `/opt/pw-browsers/chromium` in Claude's workspace.
Note: that Chromium can't play H.264 video, so landing/Pro video cards show their posters.

## Scene switches (localStorage, set with page.addInitScript)

| Key | Effect |
|---|---|
| `h-member=1` | the guest has joined event GALA26 (nickname maya), so /e/GALA26 opens the gallery |
| `h-host=1` | signed in as the host (host1); /host/ev1 is the console; the gallery shows the host bar |
| `h-tv=show` | /tv is paired and shows event GALA26 (`h-layout`: wall, justin, slideshow; `h-paused=1`) |
| `h-gs=<ms>` | a Group Shot fires at that time (`h-gs-spots=1` includes Share Spots) |
| `h-nphotos=<n>` | only the first n stub photos exist |
| `h-ended=1` | the event ended 3 hours ago (album phase) |
| `h-lens=1` | the host invited this guest's camera |
| `h-auth-fail=1` | anonymous sign-in fails with "too many requests" |

Share Spot: open /spot and enter pairing code SPT234 (pair it, then tap anywhere).
Stub photos are colored gradients; /sample uses the real sample-party images.

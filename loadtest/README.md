# Get2Share load test

Pretend guests that join a test event, watch the gallery, post photos and love photos,
all at once. It reports how fast photos upload and how fast they show up for everyone
else, then deletes everything it made.

## Run it (Mac, Terminal)

1. Check Node is installed: `node -v` (needs 18 or newer; get it from nodejs.org if not).
2. In the Host Console, make an event just for this, e.g. "Load test". Turn ON auto-approval.
   Note its 6-character code. Pair a TV to it if you want to watch.
3. In Terminal:

   ```
   cd ~/Downloads/get2share-loadtest
   npm install
   node run.mjs --code ABC123 --guests 25 --minutes 3
   ```

4. Then step up: `--guests 50`, then `--guests 100`.
5. Each run saves a `results-….json` file here. Send those to Claude.
6. When you're done, delete the "Load test" event in the Host Console.

## Options

- `--guests` pretend guests (default 25)
- `--minutes` how long they party (default 3)
- `--rate` photos per guest per minute (default 1; a busy party is about 0.5–1)
- `--ramp` seconds to bring everyone in (default 30)
- `--keep` leave the test photos and guests behind instead of cleaning up

## Good to know

- Every pretend guest is a new anonymous sign-in from your one computer. Firebase limits
  new sign-ups per network to roughly 100 an hour, so past that you'll see "sign-in" errors.
  That's Firebase guarding against abuse, not the app; real guests are on their own phones.
- It runs from your home internet, so it measures the app and Firebase, not venue Wi-Fi or
  cellular. The field test covers that.

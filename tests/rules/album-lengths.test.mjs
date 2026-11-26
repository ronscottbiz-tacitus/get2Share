// Firestore rules checks for album lengths by plan: 7 days free, 182 Party, 365 Big Event
// (and the live app's 30 days until the launch switch).
//
// Needs the Firestore emulator (Java). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing@5
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/album-lengths.test.mjs"
//
// Every check prints PASS or FAIL; the script ends with "All passed" or the number that failed.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const DAY = 24 * 60 * 60 * 1000;
const END = Date.now() + 12 * 60 * 60 * 1000; // inside the first day, so the run-time limit is met
const at = (ms) => Timestamp.fromMillis(ms);
const times = (days, end = END) => ({ endsAt: at(end), expireAt: at(end + days * DAY) });

let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

const host = () => env.authenticatedContext('host', { email: 'host@example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
const event = (db, eid = 'ev1') => doc(db, 'events', eid);

async function seed({ features = null, limitsOn = false, expireDays = 7 } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(event(db), {
      name: 'Party', ownerUid: 'host', hostUids: ['host'], joinCode: 'ABC123', access: 'link',
      autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: Timestamp.now(),
      ...times(expireDays),
    });
    await setDoc(doc(db, 'joinCodes', 'ABC123'), { eventId: 'ev1', name: 'Party', expireAt: at(END + expireDays * DAY) });
    if (features) await setDoc(doc(db, 'features', 'ev1'), features);
    await setDoc(doc(db, 'config', 'walkthrough'), { enabled: true, upgrade: limitsOn });
  });
}

/** What the app does: the event and its join code, in one write. */
function create(days, eid = 'ev2', code = 'NEW123') {
  const db = host();
  const t = times(days);
  const b = writeBatch(db);
  b.set(event(db, eid), {
    name: 'New', ownerUid: 'host', hostUids: ['host'], joinCode: code, access: 'link',
    autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: serverTimestamp(), ...t,
  });
  b.set(doc(db, 'joinCodes', code), { eventId: eid, name: 'New', expireAt: t.expireAt });
  return b.commit();
}

// --- New events (free) ---
await seed();
await check('a new event keeps its album 7 days', assertSucceeds(create(7)));
await check('not 8', assertFails(create(8, 'ev3', 'NEW124')));
await check('not a year', assertFails(create(365, 'ev4', 'NEW125')));
await check('before launch: the live app\'s 30 days are fine', assertSucceeds(create(30, 'ev5', 'NEW126')));
await seed({ limitsOn: true });
await check('after launch: 30 days is refused', assertFails(create(30, 'ev5', 'NEW126')));
await check('after launch: 7 days works', assertSucceeds(create(7, 'ev6', 'NEW127')));

// --- Changing the end time, by plan ---
await seed({ limitsOn: true });
await check('free: a new end time with 7 days', assertSucceeds(updateDoc(event(host()), times(7, END + DAY / 4))));
await check('free: not 182', assertFails(updateDoc(event(host()), times(182, END + DAY / 4))));
await check('free: the date cannot be pushed out alone', assertFails(updateDoc(event(host()), { expireAt: at(END + 365 * DAY) })));
await seed({ limitsOn: true, features: { tier: 'party', upgraded: true }, expireDays: 182 });
await check('party: 182 days', assertSucceeds(updateDoc(event(host()), times(182, END + DAY))));
await check('party: not 7', assertFails(updateDoc(event(host()), times(7, END + DAY))));
await check('party: not 365', assertFails(updateDoc(event(host()), times(365, END + DAY))));
await seed({ limitsOn: true, features: { tier: 'big', upgraded: true }, expireDays: 365 });
await check('big: 365 days', assertSucceeds(updateDoc(event(host()), times(365, END + DAY))));
await seed({ limitsOn: true, features: { pro: true }, expireDays: 365 });
await check('pro: 365 days', assertSucceeds(updateDoc(event(host()), times(365, END + DAY))));

// --- Other changes leave the date alone ---
await seed({ limitsOn: true, expireDays: 30 });
await check('an event from before (30 days) can still be renamed', assertSucceeds(updateDoc(event(host()), { name: 'Renamed' })));
await seed({ limitsOn: true, features: { tier: 'big', upgraded: true }, expireDays: 400 });
await check('a date the cloud job moved out survives other changes', assertSucceeds(updateDoc(event(host()), { autoApproval: false })));

// --- The end and the date go together ---
await seed();
await check('an end time needs a closing date after it', assertFails(updateDoc(event(host()), { endsAt: at(END), expireAt: at(END - DAY) })));
await check('removing the end time removes the date too', assertSucceeds(updateDoc(event(host()), { endsAt: null, expireAt: null })));

await env.cleanup();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);

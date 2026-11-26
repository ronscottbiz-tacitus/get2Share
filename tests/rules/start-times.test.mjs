// Firestore rules checks for start times, run time (a day free, 3 days Party, 14 days Big Event)
// and co-host limits (3 free, 10 Party, no limit Big Event).
//
// Needs the Firestore emulator (Java). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing@5
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/start-times.test.mjs"
//
// Every check prints PASS or FAIL; the script ends with "All passed" or the number that failed.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const H = 60 * 60 * 1000;
const D = 24 * H;
const at = (ms) => Timestamp.fromMillis(ms);
/** Start, end (the run time later) and the album date (free: 7 days after the end). */
const times = (startMs, runHours = 24, albumDays = 7) => ({
  startsAt: at(startMs), endsAt: at(startMs + runHours * H), expireAt: at(startMs + runHours * H + albumDays * D),
});

let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

const account = (uid) => env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
const guest = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const event = (db, eid = 'ev1') => doc(db, 'events', eid);
const photo = (uid) => ({
  url: 'https://example.com/p.jpg', nickname: uid, sessionId: uid, createdAt: Date.now(), status: 'approved',
  reactions: { likes: 0, dislikes: 0 }, flagged: false,
});

async function seed({ start = Date.now() - H, runHours = 24, albumDays = 7, features = null, limitsOn = true, hostUids = ['host'], noStart = false, createdAt = null } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const t = times(start, runHours, albumDays);
    if (noStart) delete t.startsAt;
    await setDoc(event(db), {
      name: 'BBQ', ownerUid: 'host', hostUids, joinCode: 'ABC123', access: 'link',
      autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: createdAt ?? Timestamp.now(), ...t,
    });
    await setDoc(doc(db, 'joinCodes', 'ABC123'), { eventId: 'ev1', name: 'BBQ', expireAt: t.expireAt });
    await setDoc(doc(db, 'events', 'ev1', 'members', 'maya'), { nickname: 'maya', joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
    if (features) await setDoc(doc(db, 'features', 'ev1'), features);
    await setDoc(doc(db, 'config', 'walkthrough'), { enabled: true, upgrade: limitsOn });
  });
}

/** What the app does: the event and its join code, in one write. */
function create(t, eid = 'ev2', code = 'NEW123') {
  const db = account('host');
  const b = writeBatch(db);
  b.set(event(db, eid), {
    name: 'New', ownerUid: 'host', hostUids: ['host'], joinCode: code, access: 'link',
    autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: serverTimestamp(), ...t,
  });
  b.set(doc(db, 'joinCodes', code), { eventId: eid, name: 'New', expireAt: t.expireAt });
  return b.commit();
}

// --- Making an event ---
await seed();
const now = Date.now();
await check('starting now runs a day', assertSucceeds(create(times(now))));
await check('starting Saturday runs a day from Saturday', assertSucceeds(create(times(now + 9 * D), 'ev3', 'NEW124')));
await check('a free event cannot run 2 days', assertFails(create(times(now, 48), 'ev4', 'NEW125')));
await check('a start in the past is refused', assertFails(create(times(now - 2 * H), 'ev5', 'NEW126')));
await check('a start more than a year out is refused', assertFails(create(times(now + 400 * D), 'ev6', 'NEW127')));
await seed({ limitsOn: false });
await check('before launch: the live app\'s longer events are fine', assertSucceeds(create({ endsAt: at(now + 5 * D), expireAt: at(now + 35 * D) }, 'ev7', 'NEW128')));

// --- Before it starts ---
await seed({ start: Date.now() + 3 * D });
await check('the start can move before it starts', assertSucceeds(updateDoc(event(account('host')), times(Date.now() + 4 * D))));
await check('"Start now"', assertSucceeds(updateDoc(event(account('host')), times(Date.now()))));
await seed({ start: Date.now() + 3 * D });
await check('a guest cannot add photos before the start', assertFails(setDoc(doc(guest('maya'), 'events', 'ev1', 'photos', 'p1'), photo('maya'))));
await check('a host can, to try things out', assertSucceeds(setDoc(doc(account('host'), 'events', 'ev1', 'photos', 'p2'), photo('host'))));

// --- After it starts ---
await seed({ start: Date.now() - 2 * H });
await check('a guest can add photos once it starts', assertSucceeds(setDoc(doc(guest('maya'), 'events', 'ev1', 'photos', 'p3'), photo('maya'))));
await check('a started event cannot restart its clock', assertFails(updateDoc(event(account('host')), times(Date.now() + H))));
const s = Date.now() - 2 * H;
await seed({ start: s });
await check('"End now"', assertSucceeds(updateDoc(event(account('host')), { endsAt: at(Date.now()), expireAt: at(Date.now() + 7 * D) })));
await check('reopening inside the day', assertSucceeds(updateDoc(event(account('host')), { endsAt: at(s + 20 * H), expireAt: at(s + 20 * H + 7 * D) })));
await check('not past the day', assertFails(updateDoc(event(account('host')), { endsAt: at(s + 30 * H), expireAt: at(s + 30 * H + 7 * D) })));
await seed({ start: s, runHours: 72, albumDays: 182, features: { tier: 'party', upgraded: true } });
await check('party: 3 days', assertSucceeds(updateDoc(event(account('host')), { endsAt: at(s + 70 * H), expireAt: at(s + 70 * H + 182 * D) })));
await check('party: not 4', assertFails(updateDoc(event(account('host')), { endsAt: at(s + 96 * H), expireAt: at(s + 96 * H + 182 * D) })));
await seed({ start: s, runHours: 336, albumDays: 365, features: { tier: 'big', upgraded: true } });
await check('big: 14 days', assertSucceeds(updateDoc(event(account('host')), { endsAt: at(s + 330 * H), expireAt: at(s + 330 * H + 365 * D) })));

// --- Events from before start times count from when they were made ---
const made = Date.now() - 5 * H;
await seed({ noStart: true, start: made, runHours: 2, createdAt: at(made) });
await check('an older event can reopen inside its first day', assertSucceeds(updateDoc(event(account('host')), { endsAt: at(made + 20 * H), expireAt: at(made + 20 * H + 7 * D) })));
await check('but not past it', assertFails(updateDoc(event(account('host')), { endsAt: at(made + 40 * H), expireAt: at(made + 40 * H + 7 * D) })));
await check('nor be given a start time', assertFails(updateDoc(event(account('host')), times(Date.now() + D))));

// --- Co-hosts ---
async function accept(uid) {
  // An invite the owner made, claimed by uid, and the event gaining uid, in one write.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'events', 'ev1', 'hostInvites', `invite-token-for-${uid}`), { createdAt: Timestamp.now(), eventName: 'BBQ', createdBy: 'host', claimedBy: null });
  });
  const db = account(uid);
  const b = writeBatch(db);
  b.update(doc(db, 'events', 'ev1', 'hostInvites', `invite-token-for-${uid}`), { claimedBy: uid, claimedAt: serverTimestamp() });
  b.set(doc(db, 'events', 'ev1', 'hostClaims', uid), { token: `invite-token-for-${uid}`, claimedAt: serverTimestamp(), name: uid, email: `${uid}@example.com` });
  b.update(event(db), { hostUids: [...current, uid] });
  return b.commit();
}
let current = ['host', 'c1', 'c2'];
await seed({ hostUids: current });
await check('free: a 3rd co-host joins', assertSucceeds(accept('c3')));
current = ['host', 'c1', 'c2', 'c3'];
await check('free: a 4th is refused', assertFails(accept('c4')));
await seed({ hostUids: current, limitsOn: false });
await check('before launch: no limit', assertSucceeds(accept('c4')));
current = Array.from({ length: 11 }, (_, i) => (i ? `c${i}` : 'host'));
await seed({ hostUids: current, features: { tier: 'party', upgraded: true } });
await check('party: an 11th co-host is refused', assertFails(accept('c11')));
await seed({ hostUids: current, features: { tier: 'big', upgraded: true } });
await check('big: no limit', assertSucceeds(accept('c11')));
current = ['host', 'c1', 'c2', 'c3', 'c4', 'c5'];
await seed({ hostUids: current });
await check('an event over the limit (from before) can still lose a co-host', assertSucceeds(updateDoc(event(account('host')), { hostUids: ['host', 'c1', 'c2', 'c3', 'c4'] })));

await env.cleanup();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);

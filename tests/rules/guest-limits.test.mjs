// Firestore rules checks for guest limits (free 20, Party 100, Big Event unlimited, each + 5).
//
// Needs the Firestore emulator (Java). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing@5
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/guest-limits.test.mjs"
//
// Every check prints PASS or FAIL; the script exits non-zero if any fail.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const EID = 'ev1';
let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

async function seed({ guests = 0, features = null, limitsOn = false } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'events', EID), {
      name: 'Party', ownerUid: 'host', hostUids: ['host'], joinCode: 'ABC123', access: 'link',
      autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: Timestamp.now(),
    });
    if (guests) await setDoc(doc(db, 'events', EID, 'meta', 'guests'), { n: guests, last: 'someone' });
    if (features) await setDoc(doc(db, 'features', EID), features);
    await setDoc(doc(db, 'config', 'walkthrough'), { enabled: true, upgrade: limitsOn });
  });
}

const guest = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const host = (uid = 'host') => env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
const member = (db, uid) => doc(db, 'events', EID, 'members', uid);
const count = (db) => doc(db, 'events', EID, 'meta', 'guests');
const join = (uid) => ({ nickname: uid, joinedAt: serverTimestamp(), joinCode: 'ABC123', role: 'guest' });

/** What the app does: the membership and the count, in one write. */
function countedJoin(uid, n, extra = {}) {
  const db = guest(uid);
  const b = writeBatch(db);
  b.set(member(db, uid), join(uid));
  b.set(count(db), { n, last: uid, ...extra });
  return b.commit();
}

// --- Counting ---
await seed();
await check('the first guest is counted as 1', assertSucceeds(countedJoin('g1', 1)));
await check('the next guest must be 2, not 1', assertFails(countedJoin('g2', 1)));
await check('the next guest cannot skip ahead', assertFails(countedJoin('g2', 3)));
await check('the next guest is counted as 2', assertSucceeds(countedJoin('g2', 2)));
await check('a guest cannot count someone else', assertFails((() => {
  const db = guest('g3'); const b = writeBatch(db);
  b.set(member(db, 'g3'), join('g3')); b.set(count(db), { n: 3, last: 'g9' }); return b.commit();
})()));
await check('the count cannot change without a new guest', assertFails(setDoc(count(guest('g1')), { n: 3, last: 'g1' })));
await check('a guest already in cannot count again', assertFails(setDoc(count(guest('g2')), { n: 3, last: 'g2' })));
await check('the count cannot carry other fields', assertFails(countedJoin('g3', 3, { cap: 999 })));
await check('anyone signed in can read the count', assertSucceeds(getDoc(count(guest('stranger')))));
await check('anyone signed in can read the plan', assertSucceeds(getDoc(doc(guest('stranger'), 'features', EID))));
await check('nobody can write the plan', assertFails(setDoc(doc(host(), 'features', EID), { tier: 'big' })));

// --- Free: 20 + 5 ---
await seed({ guests: 24 });
await check('free: guest 25 (the last of the grace) gets in', assertSucceeds(countedJoin('g25', 25)));
await check('free: guest 26 waits', assertFails(countedJoin('g26', 26)));

// --- Party: 100 + 5 ---
await seed({ guests: 25, features: { tier: 'party', upgraded: true, flowSeconds: 20 } });
await check('party: guest 26 gets in', assertSucceeds(countedJoin('g26', 26)));
await seed({ guests: 105, features: { tier: 'party', upgraded: true } });
await check('party: guest 106 waits', assertFails(countedJoin('g106', 106)));

// --- Big Event, Pro and hand-upgraded events: no limit ---
for (const [name, features] of [['big', { tier: 'big' }], ['pro', { pro: true }], ['marked upgraded', { upgraded: true }]]) {
  await seed({ guests: 5000, features });
  await check(`${name}: guest 5001 gets in`, assertSucceeds(countedJoin('g5001', 5001)));
}

// --- An admin's test cap ---
await seed({ guests: 2, features: { guestCap: 2 } });
await check('test cap 2: the third guest waits', assertFails(countedJoin('g3', 3)));
await seed({ guests: 2, features: { guestCap: 2, tier: 'big' } });
await check('test cap beats the tier', assertFails(countedJoin('g3', 3)));

// --- Before launch: the live app joins without counting ---
await seed({ guests: 25 });
await check('switch off: an uncounted join still works', assertSucceeds(setDoc(member(guest('old'), 'old'), join('old'))));
await check('switch off: a counted join past the cap still waits', assertFails(countedJoin('g26', 26)));

// --- After launch ---
await seed({ guests: 3, limitsOn: true });
await check('switch on: an uncounted guest join is refused', assertFails(setDoc(member(guest('old'), 'old'), join('old'))));
await check('switch on: a counted join works', assertSucceeds(countedJoin('g4', 4)));
await check('switch on: a host joins their own gallery without counting', assertSucceeds(setDoc(member(host(), 'host'), join('host'))));
await seed({ guests: 25, limitsOn: true });
await check('switch on: a full free event refuses guest 26', assertFails(countedJoin('g26', 26)));
await check('switch on: and refuses joining without counting', assertFails(setDoc(member(guest('g26'), 'g26'), join('g26'))));

// --- Removing doesn't give the spot back ---
await seed({ guests: 25 });
await env.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(member(ctx.firestore(), 'g25'), { nickname: 'g25', joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
});
await check('a host removes guest 25', assertSucceeds(deleteDoc(member(host(), 'g25'))));
await check('the count cannot go down', assertFails(setDoc(count(host()), { n: 24, last: 'host' })));
await check('guest 26 still waits', assertFails(countedJoin('g26', 26)));

await env.cleanup();
console.log(failed ? `\n${failed} FAILED` : '\nAll passed');
process.exit(failed ? 1 : 0);

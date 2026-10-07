// Firestore rules checks for "Borrow" (guests lending each other their cameras).
//
// Needs the Firestore emulator (Java). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/guest-lens.test.mjs"
//
// Every check prints PASS or FAIL; the script exits non-zero if any fail.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, addDoc, collection, serverTimestamp, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const EID = 'ev1';
let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

async function seed({ lensSharing = true, autoApproval = true } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'events', EID), {
      name: 'Party', ownerUid: 'host', hostUids: ['host'], joinCode: 'ABC123', access: 'link',
      autoApproval, guestLensEnabled: true, status: 'live', createdAt: Timestamp.now(),
      ...(lensSharing ? { lensSharing: true } : {}),
    });
    for (const [uid, n] of [['maya', 'maya'], ['jordan', 'jordan'], ['dee', 'dee']]) {
      await setDoc(doc(db, 'events', EID, 'members', uid), { nickname: n, joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
      await setDoc(doc(db, 'events', EID, 'people', uid), { nickname: n, lastSeen: Timestamp.now() });
    }
  });
}

const as = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const lens = (db, owner = 'jordan') => doc(db, 'events', EID, 'lensRequests', owner);
const ask = (from, to) => ({
  from, fromName: from, to, toName: to, status: 'asking', endReason: null,
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), frame: null, shot: null, lastShotId: null,
});

// --- Asking ---
await seed({ lensSharing: false });
await check('no asking while the host switch is off', assertFails(setDoc(lens(as('maya')), ask('maya', 'jordan'))));
await check('no check-in while the host switch is off', assertFails(setDoc(doc(as('maya'), 'events', EID, 'people', 'maya'), { nickname: 'maya', lastSeen: serverTimestamp() })));

await seed();
await check('a guest can ask another guest', assertSucceeds(setDoc(lens(as('maya')), ask('maya', 'jordan'))));
await check('a second guest cannot grab a camera someone is asking for', assertFails(setDoc(lens(as('dee')), ask('dee', 'jordan'))));
await check('nobody can ask in someone else\'s name', assertFails(setDoc(lens(as('dee'), 'maya'), ask('jordan', 'maya'))));
await check('a guest cannot ask their own camera', assertFails(setDoc(lens(as('maya'), 'maya'), ask('maya', 'maya'))));
await check('an outsider cannot read a request', assertFails(getDoc(lens(as('stranger')))));
await check('the asker can read it', assertSucceeds(getDoc(lens(as('maya')))));
await check('the camera owner can read it', assertSucceeds(getDoc(lens(as('jordan')))));
await check('the asker cannot accept for the owner', assertFails(updateDoc(lens(as('maya')), { status: 'live', updatedAt: serverTimestamp() })));

// --- Saying no, then the one-minute wait ---
await check('the owner can say no', assertSucceeds(updateDoc(lens(as('jordan')), { status: 'declined', updatedAt: serverTimestamp() })));
await check('the same guest cannot ask again right away', assertFails(setDoc(lens(as('maya')), ask('maya', 'jordan'))));
await check('a different guest can ask after a no', assertSucceeds(setDoc(lens(as('dee')), ask('dee', 'jordan'))));

// --- Live: previews, shots, the photo ---
await seed({ autoApproval: false });
await setDoc(lens(as('maya')), ask('maya', 'jordan'));
await check('the owner can say yes', assertSucceeds(updateDoc(lens(as('jordan')), { status: 'live', updatedAt: serverTimestamp() })));
await check('the owner can send a preview', assertSucceeds(updateDoc(lens(as('jordan')), { frame: 'data:image/jpeg;base64,AAAA', frameAt: serverTimestamp(), updatedAt: serverTimestamp() })));
await check('the asker cannot send previews', assertFails(updateDoc(lens(as('maya')), { frame: 'x', updatedAt: serverTimestamp() })));
await check('the asker can fire the shutter',
  assertSucceeds(updateDoc(lens(as('maya')), { shot: { id: 'ls_1', firesAt: Timestamp.fromMillis(Date.now() + 3500) }, updatedAt: serverTimestamp() })));
await check('a shot can\'t be scheduled far in the future',
  assertFails(updateDoc(lens(as('maya')), { shot: { id: 'ls_2', firesAt: Timestamp.fromMillis(Date.now() + 60_000) }, updatedAt: serverTimestamp() })));
await check('someone else cannot fire it',
  assertFails(updateDoc(lens(as('dee')), { shot: { id: 'ls_3', firesAt: Timestamp.fromMillis(Date.now() + 3500) }, updatedAt: serverTimestamp() })));

const photo = (takenBy, status = 'pending') => ({
  url: 'https://x/y.jpg', nickname: "maya on jordan's phone", sessionId: 'jordan', createdAt: Date.now(), status,
  reactions: { likes: 0, dislikes: 0 }, flagged: false, ...(takenBy ? { takenBy } : {}),
});
let photoRef;
await check('the owner uploads it credited to the asker',
  assertSucceeds(addDoc(collection(as('jordan'), 'events', EID, 'photos'), photo({ uid: 'maya', nickname: 'maya' })).then((r) => { photoRef = r; })));
await check('the owner cannot credit someone who did not ask',
  assertFails(addDoc(collection(as('jordan'), 'events', EID, 'photos'), photo({ uid: 'dee', nickname: 'dee' }))));
await check('review still applies: no self-approving', assertFails(addDoc(collection(as('jordan'), 'events', EID, 'photos'), photo({ uid: 'maya', nickname: 'maya' }, 'approved'))));
await check('the asker can see the photo while it waits for review', assertSucceeds(getDoc(doc(as('maya'), 'events', EID, 'photos', photoRef.id))));
await check('other guests cannot see it before review', assertFails(getDoc(doc(as('dee'), 'events', EID, 'photos', photoRef.id))));
await check('the owner confirms the shot', assertSucceeds(updateDoc(lens(as('jordan')), { lastShotId: 'ls_1', updatedAt: serverTimestamp() })));

// --- Ending ---
await check('the asker can close it', assertSucceeds(updateDoc(lens(as('maya')), { status: 'ended', endReason: 'closed', shot: null, frame: null, updatedAt: serverTimestamp() })));
await check('ended stays ended for the owner', assertFails(updateDoc(lens(as('jordan')), { status: 'live', updatedAt: serverTimestamp() })));
await check('anyone can ask once it ended', assertSucceeds(setDoc(lens(as('dee')), ask('dee', 'jordan'))));

// --- The host's own camera requests are untouched ---
await seed();
await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'events', EID, 'sessions', 'jordan'),
  { sessionId: 'jordan', nickname: 'jordan', role: 'guest', lastActive: Date.now() }));
await check('a guest still cannot turn on a host camera request', assertFails(updateDoc(doc(as('maya'), 'events', EID, 'sessions', 'jordan'), { invited_to_lens: true })));
await check('guests still cannot see sessions', assertFails(getDoc(doc(as('maya'), 'events', EID, 'sessions', 'jordan'))));

await env.cleanup();
console.log(failed ? `${failed} FAILED` : 'All passed');
process.exit(failed ? 1 : 0);

// Firestore rules checks for removing and blocking guests.
//
// Needs the Firestore emulator (Java). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/guest-block.test.mjs"
//
// Every check prints PASS or FAIL; the script exits non-zero if any fail.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, getDocs, deleteDoc, collection, query, where, serverTimestamp, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const EID = 'ev1';
let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

const photo = (uid, status = 'approved') => ({
  url: 'https://example.com/p.jpg', nickname: uid, sessionId: uid, createdAt: Date.now(), status,
  reactions: { likes: 0, dislikes: 0 }, flagged: false,
});

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'events', EID), {
      name: 'Party', ownerUid: 'host', hostUids: ['host', 'cohost'], joinCode: 'ABC123', access: 'link',
      autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: Timestamp.now(),
    });
    for (const uid of ['maya', 'jordan']) {
      await setDoc(doc(db, 'events', EID, 'members', uid), { nickname: uid, joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
      await setDoc(doc(db, 'events', EID, 'sessions', uid), { sessionId: uid, nickname: uid, role: 'guest', lastActive: Date.now() });
      await setDoc(doc(db, 'events', EID, 'photos', `p-${uid}`), photo(uid));
    }
  });
}

const guest = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const host = (uid = 'host') => env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
const member = (db, uid) => doc(db, 'events', EID, 'members', uid);
const session = (db, uid) => doc(db, 'events', EID, 'sessions', uid);
const blocked = (db, uid) => doc(db, 'events', EID, 'blocked', uid);
const join = (uid) => ({ nickname: uid, joinedAt: serverTimestamp(), joinCode: 'ABC123', role: 'guest' });
const block = (by, name = 'maya') => ({ nickname: name, blockedAt: serverTimestamp(), by });

// --- Remove ---
await seed();
await check('a guest cannot remove another guest', assertFails(deleteDoc(member(guest('jordan'), 'maya'))));
await check('a host can remove a guest', assertSucceeds(deleteDoc(member(host(), 'maya'))));
await check('a host can clear the removed guest\'s session', assertSucceeds(deleteDoc(session(host(), 'maya'))));
await check('a removed guest can no longer read photos', assertFails(getDoc(doc(guest('maya'), 'events', EID, 'photos', 'p-jordan'))));
await check('a removed guest cannot put their session back', assertFails(setDoc(session(guest('maya'), 'maya'), { sessionId: 'maya', nickname: 'maya', role: 'guest', lastActive: Date.now() })));
await check('a removed guest can join again with the code', assertSucceeds(setDoc(member(guest('maya'), 'maya'), join('maya'))));

// --- Block ---
await seed();
await check('a guest cannot block anyone', assertFails(setDoc(blocked(guest('jordan'), 'maya'), block('jordan'))));
await check('a host cannot block in someone else\'s name', assertFails(setDoc(blocked(host(), 'maya'), block('cohost'))));
await check('a host cannot block a host', assertFails(setDoc(blocked(host(), 'cohost'), block('host', 'cohost'))));
await check('a block cannot carry extra fields', assertFails(setDoc(blocked(host(), 'maya'), { ...block('host'), note: 'x' })));
await check('a host can block a guest', assertSucceeds(setDoc(blocked(host(), 'maya'), block('host'))));
await check('a co-host can block a guest', assertSucceeds(setDoc(blocked(host('cohost'), 'jordan'), block('cohost', 'jordan'))));
await check('a block cannot be edited', assertFails(updateDoc(blocked(host(), 'maya'), { nickname: 'other' })));
await check('the host removes the blocked guest', assertSucceeds(deleteDoc(member(host(), 'maya'))));
await check('a blocked guest cannot join again', assertFails(setDoc(member(guest('maya'), 'maya'), join('maya'))));
await check('a blocked guest can see that they are blocked', assertSucceeds(getDoc(blocked(guest('maya'), 'maya'))));
await check('a guest cannot list who is blocked', assertFails(getDocs(collection(guest('jordan'), 'events', EID, 'blocked'))));
await check('a host can list who is blocked', assertSucceeds(getDocs(collection(host(), 'events', EID, 'blocked'))));
await check('a guest cannot unblock themselves', assertFails(deleteDoc(blocked(guest('maya'), 'maya'))));
await check('someone not blocked can still join', assertSucceeds(setDoc(member(guest('dee'), 'dee'), join('dee'))));

// --- Hiding a blocked guest's photos ---
await check('a host can find a guest\'s photos', assertSucceeds(getDocs(query(collection(host(), 'events', EID, 'photos'), where('sessionId', '==', 'maya')))));
await check('a host can hide a guest\'s photo', assertSucceeds(updateDoc(doc(host(), 'events', EID, 'photos', 'p-maya'), { status: 'rejected' })));
await check('a hidden photo is gone for other guests', assertFails(getDoc(doc(guest('dee'), 'events', EID, 'photos', 'p-maya'))));

// --- Unblock ---
await check('a host can unblock', assertSucceeds(deleteDoc(blocked(host(), 'maya'))));
await check('an unblocked guest can join again', assertSucceeds(setDoc(member(guest('maya'), 'maya'), join('maya'))));

await env.cleanup();
process.exit(failed ? 1 : 0);

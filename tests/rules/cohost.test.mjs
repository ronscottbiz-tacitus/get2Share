// Firestore rules checks for co-host invites.
//
// Needs the Firestore emulator (Java 21+). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing@5
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/cohost.test.mjs"
//
// Every check prints PASS or FAIL; the script exits non-zero if any fail.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, updateDoc, getDoc, getDocs, deleteDoc, collection, writeBatch, arrayUnion, arrayRemove,
  serverTimestamp, Timestamp,
} from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const EID = 'ev1';
const TOKEN = 'tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OLD = 'tokenOLDOLDOLDOLDOLDOLDOLDOLDOLD';
let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

async function seed({ hostUids = ['owner', 'cohost'] } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'events', EID), {
      name: 'Party', ownerUid: 'owner', hostUids, joinCode: 'ABC123', access: 'link',
      autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: Timestamp.now(),
    });
    await setDoc(doc(db, 'events', EID, 'members', 'maya'), { nickname: 'maya', joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
    // A link made 25 hours ago, never used.
    await setDoc(doc(db, 'events', EID, 'hostInvites', OLD), {
      createdBy: 'owner', createdAt: Timestamp.fromMillis(Date.now() - 25 * 3600 * 1000), eventName: 'Party', claimedBy: null,
    });
  });
}

const account = (uid) => env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
const anon = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const event = (db) => doc(db, 'events', EID);
const invite = (db, token = TOKEN) => doc(db, 'events', EID, 'hostInvites', token);
const claim = (db, uid) => doc(db, 'events', EID, 'hostClaims', uid);
const newInvite = (by) => ({ createdBy: by, createdAt: serverTimestamp(), eventName: 'Party', claimedBy: null });

// Accept the way the app does: claim the invite, record the claim, join hostUids, in one write.
function accept(db, uid, { token = TOKEN, email = `${uid}@example.com`, join = uid, extra = {}, claimInvite = true } = {}) {
  const b = writeBatch(db);
  if (claimInvite) b.update(invite(db, token), { claimedBy: uid, claimedAt: serverTimestamp() });
  b.set(claim(db, uid), { token, claimedAt: serverTimestamp(), name: uid, email });
  b.update(event(db), { hostUids: arrayUnion(join), ...extra });
  return b.commit();
}

// --- Making an invite ---
await seed();
await check('a guest cannot make an invite', assertFails(setDoc(invite(anon('maya')), newInvite('maya'))));
await check('a co-host cannot make an invite', assertFails(setDoc(invite(account('cohost')), newInvite('cohost'))));
await check('an outsider cannot make an invite', assertFails(setDoc(invite(account('sam')), newInvite('sam'))));
await check('an invite cannot be made in someone else\'s name', assertFails(setDoc(invite(account('owner')), newInvite('cohost'))));
await check('an invite cannot start out claimed', assertFails(setDoc(invite(account('owner')), { ...newInvite('owner'), claimedBy: 'sam' })));
await check('an invite needs a long token', assertFails(setDoc(invite(account('owner'), 'short'), newInvite('owner'))));
await check('the owner can make an invite', assertSucceeds(setDoc(invite(account('owner')), newInvite('owner'))));
await check('someone with the link can read the invite', assertSucceeds(getDoc(invite(account('sam')))));
await check('an outsider cannot list invites', assertFails(getDocs(collection(account('sam'), 'events', EID, 'hostInvites'))));
await check('a host can list invites', assertSucceeds(getDocs(collection(account('cohost'), 'events', EID, 'hostInvites'))));

// --- Accepting ---
await check('nobody can add themselves without an invite', assertFails(updateDoc(event(account('sam')), { hostUids: arrayUnion('sam') })));
await check('a guest account cannot accept', assertFails(accept(anon('maya'), 'maya', { email: undefined })));
await check('accepting cannot add someone else', assertFails(accept(account('sam'), 'sam', { join: 'dee' })));
await check('accepting cannot change anything else on the event', assertFails(accept(account('sam'), 'sam', { extra: { name: 'Mine now' } })));
await check('the claim must carry the account\'s own email', assertFails(accept(account('sam'), 'sam', { email: 'boss@example.com' })));
await check('an expired invite cannot be accepted', assertFails(accept(account('sam'), 'sam', { token: OLD })));
await check('an invited person can accept', assertSucceeds(accept(account('sam'), 'sam')));
await check('the new co-host can open the event', assertSucceeds(getDoc(event(account('sam')))));
await check('the new co-host can moderate', assertSucceeds(updateDoc(event(account('sam')), { autoApproval: false })));
await check('an invite works only once', assertFails(accept(account('dee'), 'dee')));
await check('hosts can see who the co-hosts are', assertSucceeds(getDocs(collection(account('owner'), 'events', EID, 'hostClaims'))));
await check('a guest cannot see who the co-hosts are', assertFails(getDocs(collection(anon('maya'), 'events', EID, 'hostClaims'))));

// --- Removing ---
await check('a co-host cannot remove another co-host', assertFails(updateDoc(event(account('sam')), { hostUids: arrayRemove('cohost') })));
await check('a co-host cannot add a host', assertFails(updateDoc(event(account('sam')), { hostUids: arrayUnion('dee') })));
await check('the owner can remove a co-host', assertSucceeds(updateDoc(event(account('owner')), { hostUids: arrayRemove('sam') })));
await check('a removed co-host loses the event', assertFails(getDoc(event(account('sam')))));
await check('a removed co-host cannot get back in with the used invite', assertFails(accept(account('sam'), 'sam')));
await check('a removed co-host cannot get back in with just their old claim', assertFails(accept(account('sam'), 'sam', { claimInvite: false })));
await check('the owner can clear the old claim', assertSucceeds(deleteDoc(claim(account('owner'), 'sam'))));

// --- Who can make Flow videos ---
await check('a co-host cannot let co-hosts make Flow videos', assertFails(updateDoc(event(account('cohost')), { flowCohosts: true })));
await check('the switch must be on or off', assertFails(updateDoc(event(account('owner')), { flowCohosts: 'yes' })));
await check('the owner can let co-hosts make Flow videos', assertSucceeds(updateDoc(event(account('owner')), { flowCohosts: true })));
await check('a co-host cannot turn it back off', assertFails(updateDoc(event(account('cohost')), { flowCohosts: false })));
await check('a co-host can still change other settings', assertSucceeds(updateDoc(event(account('cohost')), { autoApproval: true })));
await check('the owner can turn it back off', assertSucceeds(updateDoc(event(account('owner')), { flowCohosts: false })));

// --- Cancelling ---
await check('a co-host cannot cancel an invite', assertFails(deleteDoc(invite(account('cohost'), OLD))));
await check('the owner can cancel an invite', assertSucceeds(deleteDoc(invite(account('owner'), OLD))));

// --- The limit: the owner plus 10 co-hosts ---
await seed({ hostUids: ['owner', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'] });
await check('owner makes an invite for the tenth co-host', assertSucceeds(setDoc(invite(account('owner')), newInvite('owner'))));
await check('a tenth co-host can accept', assertSucceeds(accept(account('sam'), 'sam')));
const T2 = 'tokenBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
await check('owner makes one more invite', assertSucceeds(setDoc(invite(account('owner'), T2), newInvite('owner'))));
await check('an eleventh co-host cannot accept', assertFails(accept(account('dee'), 'dee', { token: T2 })));

await env.cleanup();
process.exit(failed ? 1 : 0);

// Firestore rules checks for Step In (photo.stepIn and features/{eventId}).
//
// Needs the Firestore emulator (Java). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/step-in.test.mjs"
//
// Every check prints PASS or FAIL; the script exits non-zero if any fail.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, Timestamp, serverTimestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const EID = 'ev1';
let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

const STEP_IN = { status: 'ready', inUrl: 'https://example.com/in.ply', outUrl: null, people: 2 };
const photo = (extra = {}) => ({
  url: 'https://example.com/p.jpg', nickname: 'maya', sessionId: 'maya', createdAt: Date.now(),
  status: 'approved', reactions: { likes: 0, dislikes: 0 }, flagged: false, ...extra,
});

await env.clearFirestore();
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'events', EID), {
    name: 'Party', ownerUid: 'host', hostUids: ['host'], joinCode: 'ABC123', access: 'link',
    autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: Timestamp.now(),
  });
  await setDoc(doc(db, 'events', EID, 'members', 'maya'), { nickname: 'maya', joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
  await setDoc(doc(db, 'events', EID, 'photos', 'withStepIn'), photo({ stepIn: STEP_IN }));
  await setDoc(doc(db, 'events', EID, 'photos', 'plain'), photo());
  await setDoc(doc(db, 'features', EID), { pro: true });
});

const guest = env.authenticatedContext('maya', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const host = env.authenticatedContext('host', { firebase: { sign_in_provider: 'google.com' }, email: 'host@example.com', email_verified: true }).firestore();
const stranger = env.authenticatedContext('nobody', { firebase: { sign_in_provider: 'google.com' }, email: 'x@example.com', email_verified: true }).firestore();

// Photos that have a Step In moment keep working for everyone.
await check('guest sees a photo with stepIn', assertSucceeds(getDoc(doc(guest, 'events', EID, 'photos', 'withStepIn'))));
await check('guest can love a photo with stepIn', assertSucceeds(updateDoc(doc(guest, 'events', EID, 'photos', 'withStepIn'), { reactions: { likes: 1, dislikes: 0 } })));
await check('guest can report a photo with stepIn', assertSucceeds(updateDoc(doc(guest, 'events', EID, 'photos', 'withStepIn'), { flagged: true })));
await check('host can hide a photo with stepIn', assertSucceeds(updateDoc(doc(host, 'events', EID, 'photos', 'withStepIn'), { status: 'rejected' })));

// Only the cloud job writes stepIn.
await check('guest cannot add stepIn to a photo', assertFails(updateDoc(doc(guest, 'events', EID, 'photos', 'plain'), { stepIn: STEP_IN })));
await check('host cannot add stepIn to a photo', assertFails(updateDoc(doc(host, 'events', EID, 'photos', 'plain'), { stepIn: STEP_IN })));
await check('host cannot change stepIn', assertFails(updateDoc(doc(host, 'events', EID, 'photos', 'withStepIn'), { 'stepIn.inUrl': 'https://evil.example/x.ply' })));
await check('guest cannot upload a photo that already has stepIn', assertFails(setDoc(doc(guest, 'events', EID, 'photos', 'newOne'), photo({ stepIn: STEP_IN }))));
await check('guest can still upload a normal photo', assertSucceeds(setDoc(doc(guest, 'events', EID, 'photos', 'newTwo'), photo())));

// features/{eventId}: hosts read, nobody writes.
await check('host reads features', assertSucceeds(getDoc(doc(host, 'features', EID))));
await check('guest cannot read features', assertFails(getDoc(doc(guest, 'features', EID))));
await check('stranger cannot read features', assertFails(getDoc(doc(stranger, 'features', EID))));
await check('host cannot turn Pro on', assertFails(setDoc(doc(host, 'features', EID), { pro: true })));
await check('host cannot edit features', assertFails(updateDoc(doc(host, 'features', EID), { keep: true })));

// config/stepIn: anyone signed in reads it; nobody writes it.
await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'config', 'stepIn'), { allHosts: true }); });
await check('guest reads config/stepIn', assertSucceeds(getDoc(doc(guest, 'config', 'stepIn'))));
await check('host cannot change config/stepIn', assertFails(setDoc(doc(host, 'config', 'stepIn'), { allHosts: false })));
await check('other config docs stay closed', assertFails(getDoc(doc(host, 'config', 'other'))));

// Join timer: each phone writes its own record; hosts read them.
const timing = { nickname: 'maya', steps: { opened: 400, signedIn: 900, gallery: 2100 }, notes: { signIn: 'remembered' },
  device: 'iPhone iOS 18.1 Safari', network: 'unknown', at: serverTimestamp() };
await check('guest saves own join timing', assertSucceeds(setDoc(doc(guest, 'events', EID, 'timings', 'maya'), timing)));
await check('guest cannot save timing for someone else', assertFails(setDoc(doc(guest, 'events', EID, 'timings', 'other'), timing)));
await check('guest cannot read join timings', assertFails(getDoc(doc(guest, 'events', EID, 'timings', 'maya'))));
await check('host reads join timings', assertSucceeds(getDoc(doc(host, 'events', EID, 'timings', 'maya'))));
await check('stranger cannot save a timing', assertFails(setDoc(doc(stranger, 'events', EID, 'timings', 'nobody'), timing)));

await env.cleanup();
console.log(failed ? `${failed} FAILED` : 'All Step In rules checks passed.');
process.exit(failed ? 1 : 0);

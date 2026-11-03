// Firestore rules checks for Walkthrough videos (events/{eid}/walkthroughs and config/walkthrough).
//
// Needs the Firestore emulator (Java). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/walkthrough.test.mjs"
//
// Every check prints PASS or FAIL; the script exits non-zero if any fail.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const EID = 'ev1';
let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

const video = (status) => ({ status, aspect: '9:16', seconds: 15, clips: [], videoUrl: 'https://example.com/v.mp4', label: 'x' });

await env.clearFirestore();
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'events', EID), {
    name: 'Party', ownerUid: 'host', hostUids: ['host', 'cohost'], joinCode: 'ABC123', access: 'link',
    autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: Timestamp.now(),
  });
  await setDoc(doc(db, 'events', EID, 'members', 'maya'), { nickname: 'maya', joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
  await setDoc(doc(db, 'events', EID, 'members', 'tv'), { nickname: 'Main TV', joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
  for (const status of ['queued', 'generating', 'joining', 'preview', 'failed', 'blocked', 'published']) {
    await setDoc(doc(db, 'events', EID, 'walkthroughs', status), video(status));
  }
  await setDoc(doc(db, 'config', 'walkthrough'), { enabled: true, allHosts: false });
  await setDoc(doc(db, 'walkthroughJobs', `${EID}__published`), { active: false, reservations: {} });
  await setDoc(doc(db, 'walkthroughUsage', 'global-2026-11'), { spentUsd: 1 });
});

const anon = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const google = (uid, email = `${uid}@example.com`) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'google.com' }, email, email_verified: true }).firestore();
const guest = anon('maya');
const tv = anon('tv');
const host = google('host');
const cohost = google('cohost');
const admin = google('someadmin', 'ronscottbiz@gmail.com');
const stranger = google('nobody');
const outsider = anon('outsider');
const signedOut = env.unauthenticatedContext().firestore();
const wt = (db, id) => doc(db, 'events', EID, 'walkthroughs', id);
const col = (db) => collection(db, 'events', EID, 'walkthroughs');
const published = (db) => query(col(db), where('status', '==', 'published'));

// Hosts read everything.
for (const status of ['queued', 'generating', 'preview', 'failed', 'blocked', 'published']) {
  await check(`host reads a ${status} video`, assertSucceeds(getDoc(wt(host, status))));
}
await check('co-host reads a preview', assertSucceeds(getDoc(wt(cohost, 'preview'))));
await check('admin reads a preview', assertSucceeds(getDoc(wt(admin, 'preview'))));
await check('host lists all videos', assertSucceeds(getDocs(col(host))));

// Members see only published videos.
await check('guest reads the published video', assertSucceeds(getDoc(wt(guest, 'published'))));
await check('TV reads the published video', assertSucceeds(getDoc(wt(tv, 'published'))));
await check('guest lists published videos', assertSucceeds(getDocs(published(guest))));
await check('TV lists published videos', assertSucceeds(getDocs(published(tv))));
for (const status of ['queued', 'generating', 'joining', 'preview', 'failed', 'blocked']) {
  await check(`guest cannot read a ${status} video`, assertFails(getDoc(wt(guest, status))));
  await check(`TV cannot read a ${status} video`, assertFails(getDoc(wt(tv, status))));
}
await check('guest cannot list every video', assertFails(getDocs(col(guest))));
await check('guest cannot list previews', assertFails(getDocs(query(col(guest), where('status', '==', 'preview')))));

// Outsiders see nothing.
await check('stranger cannot read the published video', assertFails(getDoc(wt(stranger, 'published'))));
await check('stranger cannot list published videos', assertFails(getDocs(published(stranger))));
await check('anonymous outsider cannot read it', assertFails(getDoc(wt(outsider, 'published'))));
await check('signed-out cannot read it', assertFails(getDoc(wt(signedOut, 'published'))));

// A video taken down is host-only again.
await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(wt(ctx.firestore(), 'published'), { status: 'preview' }); });
await check('guest loses a video that was taken down', assertFails(getDoc(wt(guest, 'published'))));
await check('host still reads it', assertSucceeds(getDoc(wt(host, 'published'))));
await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(wt(ctx.firestore(), 'published'), { status: 'published' }); });

// Nobody writes from the app: not guests, hosts, or admins.
for (const [who, db] of [['guest', guest], ['host', host], ['admin', admin], ['stranger', stranger]]) {
  await check(`${who} cannot create a video`, assertFails(setDoc(wt(db, 'new'), video('published'))));
  await check(`${who} cannot publish a preview`, assertFails(updateDoc(wt(db, 'preview'), { status: 'published' })));
  await check(`${who} cannot change a video's link`, assertFails(updateDoc(wt(db, 'published'), { videoUrl: 'https://evil.example/x.mp4' })));
  await check(`${who} cannot delete a video`, assertFails(deleteDoc(wt(db, 'published'))));
}

// config/walkthrough: anyone signed in reads it; nobody writes it.
await check('guest reads config/walkthrough', assertSucceeds(getDoc(doc(guest, 'config', 'walkthrough'))));
await check('host reads config/walkthrough', assertSucceeds(getDoc(doc(host, 'config', 'walkthrough'))));
await check('signed-out cannot read config/walkthrough', assertFails(getDoc(doc(signedOut, 'config', 'walkthrough'))));
await check('host cannot turn it on for everyone', assertFails(setDoc(doc(host, 'config', 'walkthrough'), { enabled: true, allHosts: true })));
await check('admin cannot change it from the app', assertFails(updateDoc(doc(admin, 'config', 'walkthrough'), { allHosts: true })));
await check('guest cannot delete it', assertFails(deleteDoc(doc(guest, 'config', 'walkthrough'))));
await check('config/stepIn stays readable', assertSucceeds(getDoc(doc(guest, 'config', 'stepIn'))));
await check('other config docs stay closed', assertFails(getDoc(doc(host, 'config', 'other'))));

// The job's private records are closed to everyone: budget, limits, frame links.
for (const [who, db] of [['guest', guest], ['host', host], ['admin', admin]]) {
  await check(`${who} cannot read job records`, assertFails(getDoc(doc(db, 'walkthroughJobs', `${EID}__published`))));
  await check(`${who} cannot read usage`, assertFails(getDoc(doc(db, 'walkthroughUsage', 'global-2026-11'))));
  await check(`${who} cannot reset usage`, assertFails(setDoc(doc(db, 'walkthroughUsage', 'global-2026-11'), { spentUsd: 0 })));
}

await env.cleanup();
console.log(failed ? `${failed} FAILED` : 'All Walkthrough rules checks passed.');
process.exit(failed ? 1 : 0);

// Storage rules checks (storage.rules): who can upload, read, list and delete photo files.
//
// Needs the Firestore and Storage emulators (Java), because the Storage rules read Firestore.
// From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing
//   npx firebase emulators:exec --only firestore,storage --project demo-get2share "node tests/rules/storage.test.mjs"
//
// Every check prints PASS or FAIL; the script exits non-zero if any fail.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, Timestamp } from 'firebase/firestore';
import { ref, uploadBytes, getMetadata, getDownloadURL, listAll, list, deleteObject } from 'firebase/storage';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  storage: { rules: readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8') },
});

let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const IMG = { contentType: 'image/jpeg' };

await env.clearFirestore();
await env.clearStorage();
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'events', 'ev1'), {
    name: 'Party', ownerUid: 'owner', hostUids: ['owner', 'cohost'], joinCode: 'ABC123', access: 'link',
    autoApproval: true, status: 'live', createdAt: Timestamp.now(),
  });
  for (const uid of ['maya', 'jordan', 'spot1']) {
    await setDoc(doc(db, 'events', 'ev1', 'members', uid), { nickname: uid, joinedAt: Timestamp.now(), joinCode: 'ABC123', role: uid === 'spot1' ? 'spot' : 'guest' });
  }
  const st = ctx.storage();
  await uploadBytes(ref(st, 'events/ev1/maya/1_a.jpg'), JPEG, IMG);
  await uploadBytes(ref(st, 'events/ev1/jordan/1_b.jpg'), JPEG, IMG);
  await uploadBytes(ref(st, 'events/ev1/jordan/1_c.jpg'), JPEG, IMG);
  await uploadBytes(ref(st, 'events/ev1/jordan/1_d.jpg'), JPEG, IMG);
  await uploadBytes(ref(st, 'photos/maya/old.jpg'), JPEG, IMG);
  await uploadBytes(ref(st, 'photos/jordan/old.jpg'), JPEG, IMG);
  await uploadBytes(ref(st, 'moments/ev1/p1-in.sog'), JPEG, { contentType: 'application/octet-stream' });
});

const anon = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).storage();
const google = (uid, email) => env.authenticatedContext(uid, { email, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).storage();
const maya = anon('maya');
const jordan = anon('jordan');
const stranger = anon('stranger');
const spot = anon('spot1');
const owner = google('owner', 'owner@example.com');
const cohost = google('cohost', 'cohost@example.com');
const admin = google('ron', 'ronscottbiz@gmail.com');
const signedOut = env.unauthenticatedContext().storage();

// --- Uploading ---
await check('a guest uploads into their own folder', assertSucceeds(uploadBytes(ref(maya, 'events/ev1/maya/2_new.jpg'), JPEG, IMG)));
await check('a Share Spot uploads into its own folder', assertSucceeds(uploadBytes(ref(spot, 'events/ev1/spot1/2_new.jpg'), JPEG, IMG)));
await check('the owner uploads (host camera)', assertSucceeds(uploadBytes(ref(owner, 'events/ev1/owner/2_new.jpg'), JPEG, IMG)));
await check('a co-host uploads', assertSucceeds(uploadBytes(ref(cohost, 'events/ev1/cohost/2_new.jpg'), JPEG, IMG)));
await check('an admin uploads into any event', assertSucceeds(uploadBytes(ref(admin, 'events/ev1/ron/2_new.jpg'), JPEG, IMG)));
await check("a guest cannot upload into another guest's folder", assertFails(uploadBytes(ref(maya, 'events/ev1/jordan/2_x.jpg'), JPEG, IMG)));
await check('someone who never joined cannot upload', assertFails(uploadBytes(ref(stranger, 'events/ev1/stranger/2_x.jpg'), JPEG, IMG)));
await check('nobody uploads under an event that does not exist', assertFails(uploadBytes(ref(maya, 'events/nope/maya/2_x.jpg'), JPEG, IMG)));
await check("a member of one event cannot upload under another", assertFails(uploadBytes(ref(maya, 'events/ev2/maya/2_x.jpg'), JPEG, IMG)));
await check('signed-out cannot upload', assertFails(uploadBytes(ref(signedOut, 'events/ev1/maya/2_x.jpg'), JPEG, IMG)));
await check('only images', assertFails(uploadBytes(ref(maya, 'events/ev1/maya/2_x.html'), JPEG, { contentType: 'text/html' })));
await check('under 5 MB', assertFails(uploadBytes(ref(maya, 'events/ev1/maya/2_big.jpg'), new Uint8Array(5 * 1024 * 1024), IMG)));
await check("no replacing your own file once it's there", assertFails(uploadBytes(ref(maya, 'events/ev1/maya/1_a.jpg'), JPEG, IMG)));
await check("a host can't replace a guest's file either", assertFails(uploadBytes(ref(owner, 'events/ev1/maya/1_a.jpg'), JPEG, IMG)));
await check('no new uploads to the old photos/ folder', assertFails(uploadBytes(ref(maya, 'photos/maya/new.jpg'), JPEG, IMG)));
await check('no uploads to moments/', assertFails(uploadBytes(ref(owner, 'moments/ev1/x.sog'), JPEG, IMG)));

// --- Reading through the SDK (getDownloadURL, getMetadata) ---
await check('the uploader gets their download link', assertSucceeds(getDownloadURL(ref(maya, 'events/ev1/maya/1_a.jpg'))));
await check('a host reads a file', assertSucceeds(getMetadata(ref(cohost, 'events/ev1/maya/1_a.jpg'))));
await check('an admin reads a file', assertSucceeds(getMetadata(ref(admin, 'events/ev1/maya/1_a.jpg'))));
await check("another guest cannot read a guest's file through the SDK", assertFails(getMetadata(ref(jordan, 'events/ev1/maya/1_a.jpg'))));
await check('a stranger cannot read a file', assertFails(getDownloadURL(ref(stranger, 'events/ev1/maya/1_a.jpg'))));
await check('signed-out cannot read a file', assertFails(getMetadata(ref(signedOut, 'events/ev1/maya/1_a.jpg'))));
await check('nobody reads moments/ through the SDK', assertFails(getMetadata(ref(owner, 'moments/ev1/p1-in.sog'))));

// --- Listing ---
await check("a stranger cannot list a guest's folder", assertFails(listAll(ref(stranger, 'events/ev1/jordan'))));
await check('a guest cannot list their own folder', assertFails(list(ref(jordan, 'events/ev1/jordan'))));
await check('a host cannot list folders', assertFails(listAll(ref(owner, 'events/ev1/jordan'))));
await check('nobody lists the event', assertFails(listAll(ref(owner, 'events/ev1'))));

// --- Deleting ---
await check('another guest cannot delete it', assertFails(deleteObject(ref(maya, 'events/ev1/jordan/1_b.jpg'))));
await check('a stranger cannot delete it', assertFails(deleteObject(ref(stranger, 'events/ev1/jordan/1_b.jpg'))));
await check('the uploader deletes their file', assertSucceeds(deleteObject(ref(jordan, 'events/ev1/jordan/1_b.jpg'))));
await check('a co-host deletes a guest file', assertSucceeds(deleteObject(ref(cohost, 'events/ev1/jordan/1_c.jpg'))));
await check('an admin deletes a file', assertSucceeds(deleteObject(ref(admin, 'events/ev1/jordan/1_d.jpg'))));
await check('old photos/: the uploader still deletes theirs', assertSucceeds(deleteObject(ref(maya, 'photos/maya/old.jpg'))));
await check("old photos/: not someone else's", assertFails(deleteObject(ref(maya, 'photos/jordan/old.jpg'))));

await env.cleanup();
console.log(failed ? `${failed} FAILED` : 'All Storage rules checks passed.');
process.exit(failed ? 1 : 0);

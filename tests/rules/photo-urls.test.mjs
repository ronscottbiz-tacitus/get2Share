// Firestore rules checks for a photo's url: new photos must point at our own Storage file
// (the uploader's folder in this event) or be an inline image. Old photos keep working.
//
// Needs the Firestore emulator (Java). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/photo-urls.test.mjs"
//
// Every check prints PASS or FAIL; the script exits non-zero if any fail.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, deleteDoc, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const EID = 'ev1';
let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

// What getDownloadURL returns for events/<eid>/<uid>/<file> in the live bucket.
const BUCKET = 'get2share.firebasestorage.app';
const link = (path, { bucket = BUCKET, host = 'firebasestorage.googleapis.com', token = 'c0ffee00-1234-4abc-9def-0123456789ab' } = {}) =>
  `https://${host}/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
const own = (uid, eid = EID) => link(`events/${eid}/${uid}/1764200000000_IMG_0042.jpg`);
const INLINE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAg=';

const photo = (uid, url, extra = {}) => ({
  url, nickname: uid, sessionId: uid, createdAt: Date.now(), status: 'approved',
  reactions: { likes: 0, dislikes: 0 }, flagged: false, ...extra,
});

await env.clearFirestore();
await env.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  for (const eid of [EID, 'ev2']) {
    await setDoc(doc(db, 'events', eid), {
      name: 'Party', ownerUid: 'host', hostUids: ['host'], joinCode: eid === EID ? 'ABC123' : 'XYZ789', access: 'link',
      autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: Timestamp.now(),
    });
    await setDoc(doc(db, 'events', eid, 'members', 'maya'), { nickname: 'maya', joinedAt: Timestamp.now(), joinCode: eid === EID ? 'ABC123' : 'XYZ789', role: 'guest' });
  }
  await setDoc(doc(db, 'events', EID, 'members', 'jordan'), { nickname: 'jordan', joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
  // A photo saved before this rule, with an outside link.
  await setDoc(doc(db, 'events', EID, 'photos', 'old'), photo('jordan', 'https://example.com/p.jpg'));
});

const guest = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const google = (uid, email) => env.authenticatedContext(uid, { email, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
const maya = guest('maya');
const host = google('host', 'host@example.com');
const admin = google('admin', 'ronscottbiz@gmail.com');
const ref = (db, id, eid = EID) => doc(db, 'events', eid, 'photos', id);

// --- Allowed: what the app really writes ---
await check('guest posts a download link to their own file in this event', assertSucceeds(setDoc(ref(maya, 'a1'), photo('maya', own('maya')))));
await check('guest posts an inline photo (the upload fallback)', assertSucceeds(setDoc(ref(maya, 'a2'), photo('maya', INLINE))));
await check('png and webp inline photos are fine too', assertSucceeds(Promise.all([
  setDoc(ref(maya, 'a3'), photo('maya', 'data:image/png;base64,iVBORw0KGgo=')),
  setDoc(ref(maya, 'a4'), photo('maya', 'data:image/webp;base64,UklGRg==')),
])));
await check('host posts their own file (host camera)', assertSucceeds(setDoc(ref(host, 'a5'), photo('host', own('host')))));
await check('a pending photo with its own file is fine', assertSucceeds(setDoc(ref(maya, 'a6'), photo('maya', own('maya'), { status: 'pending' }))));
await check('admin posts their own file', assertSucceeds(setDoc(ref(admin, 'a7'), photo('admin', own('admin')))));

// --- Refused: anything that isn't our own file ---
const bad = {
  'an outside https link': 'https://example.com/p.jpg',
  'an http link': own('maya').replace('https://', 'http://'),
  'a private address': 'http://169.254.169.254/computeMetadata/v1/',
  'a javascript: link': 'javascript:alert(document.domain)',
  'a data: page that is not an image': 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'an inline svg': 'data:image/svg+xml;base64,PHN2Zy8+',
  'an inline image that is not base64': 'data:image/jpeg,hello',
  'an inline image with an extra comma': 'data:image/jpeg;base64,AAAA,BBBB',
  'an empty inline image': 'data:image/jpeg;base64,',
  "another guest's file": own('jordan'),
  "another event's file": own('maya', 'ev2'),
  'a file in a subfolder': link('events/ev1/maya/x/a.jpg'),
  'a path that climbs out': link('events/ev1/maya/../jordan/a.jpg'),
  'a Step In moment file': link('moments/ev1/p1-in.sog'),
  'the old photos/ folder': link('photos/maya/a.jpg'),
  "another project's bucket": link('events/ev1/maya/a.jpg', { bucket: 'someone-else.appspot.com' }),
  'a look-alike host': link('events/ev1/maya/a.jpg', { host: 'firebasestorage.googleapis.com.example.com' }),
  'a link with extra text on the end': own('maya') + '&x=https://example.com',
  'a link without its token': link('events/ev1/maya/a.jpg').replace(/&token=.*$/, ''),
  'a link with a very long token': link('events/ev1/maya/a.jpg', { token: 'a'.repeat(3000) }),
};
let n = 0;
for (const [what, url] of Object.entries(bad)) {
  await check(`guest cannot post ${what}`, assertFails(setDoc(ref(maya, `b${n++}`), photo('maya', url))));
}
await check('host cannot post an outside link either', assertFails(setDoc(ref(host, 'h1'), photo('host', 'https://example.com/p.jpg'))));
await check("host cannot post a guest's file as their own", assertFails(setDoc(ref(host, 'h2'), photo('host', own('maya')))));
await check('admin cannot post an outside link', assertFails(setDoc(ref(admin, 'h3'), photo('admin', 'https://example.com/p.jpg'))));
await check("admin cannot post another event's file", assertFails(setDoc(ref(admin, 'h4'), photo('admin', own('maya', 'ev2')))));
await check("admin cannot post a guest's file", assertFails(setDoc(ref(admin, 'h5'), photo('admin', own('jordan')))));

// --- A photo's url can't be swapped later ---
await check('guest cannot change the url of their photo', assertFails(updateDoc(ref(maya, 'a1'), { url: 'https://example.com/p.jpg' })));
await check('host cannot change the url of a photo', assertFails(updateDoc(ref(host, 'a1'), { url: own('host') })));

// --- Photos saved before this rule keep working ---
await check('an old photo is still visible', assertSucceeds(getDoc(ref(maya, 'old'))));
await check('an old photo can still be loved', assertSucceeds(updateDoc(ref(maya, 'old'), { reactions: { likes: 1, dislikes: 0 } })));
await check('an old photo can still be reported', assertSucceeds(updateDoc(ref(maya, 'old'), { flagged: true })));
await check('a host can still hide an old photo', assertSucceeds(updateDoc(ref(host, 'old'), { status: 'rejected' })));
await check('a host can still delete an old photo', assertSucceeds(deleteDoc(ref(host, 'old'))));

await env.cleanup();
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Get2Share load test: many pretend guests at one test event, all at once.
//
// Each pretend guest signs in like a real phone (its own anonymous account),
// joins the event, watches the gallery live, posts photos and loves photos.
// It measures how long uploads take and how long a new photo takes to show up
// on everyone else's gallery, then cleans up after itself.
//
//   node run.mjs --code ABC123 --guests 50 --minutes 5
//
// Options
//   --code       the TEST event's join code (required). Use an event made just for this.
//   --guests     how many pretend guests (default 25)
//   --minutes    how long they party (default 3)
//   --rate       photos per guest per minute (default 1)
//   --ramp       seconds to bring everyone in (default 30)
//   --keep       leave the photos and guests behind (default: clean up)
//
// Turn ON auto-approval for the test event, so photos reach galleries right away.

import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously, deleteUser } from 'firebase/auth';
import {
  getFirestore, doc, getDoc, setDoc, addDoc, deleteDoc, updateDoc, collection, query, where,
  onSnapshot, serverTimestamp, increment, arrayUnion,
} from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

const firebaseConfig = {
  apiKey: 'AIzaSyDqJUcbT7iWHL58VYwf4QRQGVWRtf2dVbQ',
  authDomain: 'get2share.firebaseapp.com',
  projectId: 'get2share',
  storageBucket: 'get2share.firebasestorage.app',
  messagingSenderId: '770331945869',
  appId: '1:770331945869:web:a750188ba4fe331cfe6bc4',
};

// ---------- options ----------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const CODE = String(opt('code', '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
const GUESTS = Number(opt('guests', 25));
const MINUTES = Number(opt('minutes', 3));
const RATE = Number(opt('rate', 1));
const RAMP_S = Number(opt('ramp', 30));
const KEEP = !!opt('keep', false);
if (CODE.length !== 6) {
  console.error('Give the test event\'s 6-character join code: node run.mjs --code ABC123');
  process.exit(1);
}

const PHOTO = new Uint8Array(readFileSync(new URL('./sample.jpg', import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.5 + Math.random());

// ---------- measurements ----------
const m = {
  joinMs: [], uploadMs: [], writeMs: [], deliveryMs: [], loveMs: [],
  joined: 0, posted: 0, loves: 0, docsDelivered: 0, loveUpdates: 0,
  errors: {}, // kind -> { count, sample }
  startedAt: Date.now(),
};
function fail(kind, err) {
  const e = (m.errors[kind] ||= { count: 0, sample: '' });
  e.count++;
  if (!e.sample) e.sample = String(err?.code || err?.message || err).slice(0, 160);
}
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const fmt = (arr) => (arr.length ? `${pct(arr, 50)} ms typical · ${pct(arr, 95)} ms slowest 5%` : '—');

// ---------- one pretend guest ----------
async function guest(i, event) {
  const app = initializeApp(firebaseConfig, `guest-${i}`);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);
  const g = { i, app, auth, db, storage, uid: null, photos: [], seen: [], unsub: null, alive: true, loaded: false };

  // Join, like a phone scanning the QR.
  const t0 = Date.now();
  try {
    const cred = await signInAnonymously(auth);
    g.uid = cred.user.uid;
  } catch (err) {
    fail('sign-in', err);
    g.alive = false;
    return g;
  }
  try {
    await setDoc(doc(db, 'events', event.id, 'members', g.uid), {
      nickname: `loadbot-${i}`, joinedAt: serverTimestamp(), joinCode: CODE, role: 'guest',
      ...(event.expireAt ? { expireAt: event.expireAt } : {}),
    });
    m.joinMs.push(Date.now() - t0);
    m.joined++;
  } catch (err) {
    fail('join', err);
    g.alive = false;
    return g;
  }

  // Watch the gallery, like the guest's phone does.
  g.unsub = onSnapshot(
    query(collection(db, 'events', event.id, 'photos'), where('status', '==', 'approved')),
    (snap) => {
      const now = Date.now();
      // The first snapshot is the gallery as it was when this guest joined: photos
      // already there aren't "new arrivals", so they don't count toward delivery time.
      const first = !g.loaded;
      g.loaded = true;
      snap.docChanges().forEach((ch) => {
        m.docsDelivered++;
        if (ch.type === 'modified') m.loveUpdates++;
        if (ch.type !== 'added' || first) {
          if (ch.type === 'added') g.seen.push(ch.doc.id);
          return;
        }
        const id = ch.doc.id;
        g.seen.push(id);
        const d = ch.doc.data();
        // Time only photos this test posted (same computer clock), and not the guest's own.
        if (String(d.nickname || '').startsWith('loadbot-') && d.sessionId !== g.uid && typeof d.createdAt === 'number') {
          m.deliveryMs.push(now - d.createdAt);
        }
      });
    },
    (err) => fail('gallery listener', err)
  );
  return g;
}

async function postPhoto(g, event) {
  const name = `${Date.now()}_loadtest.jpg`;
  const path = `events/${event.id}/${g.uid}/${name}`;
  let url;
  const t0 = Date.now();
  try {
    const res = await uploadBytes(ref(g.storage, path), PHOTO, { contentType: 'image/jpeg' });
    url = await getDownloadURL(res.ref);
    m.uploadMs.push(Date.now() - t0);
  } catch (err) {
    fail('photo upload', err);
    return;
  }
  const createdAt = Date.now();
  try {
    const t1 = Date.now();
    const docRef = await addDoc(collection(g.db, 'events', event.id, 'photos'), {
      url, nickname: `loadbot-${g.i}`, sessionId: g.uid, createdAt,
      status: event.autoApproval ? 'approved' : 'pending',
      reactions: { likes: 0, dislikes: 0 }, flagged: false,
      ...(event.expireAt ? { expireAt: event.expireAt } : {}),
    });
    m.writeMs.push(Date.now() - t1);
    g.photos.push({ id: docRef.id, path });
    m.posted++;
  } catch (err) {
    fail('photo save', err);
  }
}

async function love(g, event) {
  const candidates = g.seen.filter((id) => !g.photos.some((p) => p.id === id));
  if (!candidates.length) return;
  const id = candidates[Math.floor(Math.random() * candidates.length)];
  const t0 = Date.now();
  try {
    await updateDoc(doc(g.db, 'events', event.id, 'photos', id), { 'reactions.likes': increment(1) });
    await updateDoc(doc(g.db, 'events', event.id, 'members', g.uid), { loved: arrayUnion(id) }).catch(() => {});
    m.loveMs.push(Date.now() - t0);
    m.loves++;
  } catch (err) {
    fail('love', err);
  }
}

async function partyLoop(g, event, until) {
  const photoEvery = 60_000 / Math.max(RATE, 0.01);
  let nextPhoto = Date.now() + jitter(photoEvery);
  let nextLove = Date.now() + jitter(20_000);
  while (Date.now() < until && g.alive) {
    const now = Date.now();
    if (now >= nextPhoto) { await postPhoto(g, event); nextPhoto = Date.now() + jitter(photoEvery); }
    if (now >= nextLove) { await love(g, event); nextLove = Date.now() + jitter(20_000); }
    await sleep(500);
  }
}

async function cleanup(g, event) {
  try { g.unsub?.(); } catch { /* */ }
  if (!KEEP && g.uid) {
    for (const p of g.photos) {
      await deleteDoc(doc(g.db, 'events', event.id, 'photos', p.id)).catch((e) => fail('cleanup', e));
      await deleteObject(ref(g.storage, p.path)).catch((e) => fail('cleanup', e));
    }
    await deleteDoc(doc(g.db, 'events', event.id, 'members', g.uid)).catch((e) => fail('cleanup', e));
    await deleteDoc(doc(g.db, 'users', g.uid, 'joined', event.id)).catch(() => {});
    if (g.auth.currentUser) await deleteUser(g.auth.currentUser).catch((e) => fail('cleanup', e));
  }
  await deleteApp(g.app).catch(() => {});
}

function report(final = false) {
  const secs = Math.round((Date.now() - m.startedAt) / 1000);
  const lines = [
    `${final ? '\n===== RESULTS =====' : `\n--- ${secs}s ---`}`,
    `Guests joined:      ${m.joined} of ${GUESTS}`,
    `Photos posted:      ${m.posted}   Loves: ${m.loves}`,
    `Join time:          ${fmt(m.joinMs)}`,
    `Photo upload:       ${fmt(m.uploadMs)}`,
    `Photo save:         ${fmt(m.writeMs)}`,
    `Shows up for others:${' '}${fmt(m.deliveryMs)}`,
    `Love:               ${fmt(m.loveMs)}`,
    `Gallery updates delivered (≈ database reads): ${m.docsDelivered} (from loves: ${m.loveUpdates})`,
  ];
  const errs = Object.entries(m.errors);
  lines.push(errs.length ? `Errors: ${errs.map(([k, v]) => `${k} ×${v.count} (${v.sample})`).join(' | ')}` : 'Errors: none');
  console.log(lines.join('\n'));
}

// ---------- main ----------
(async () => {
  console.log(`Get2Share load test → event ${CODE}: ${GUESTS} guests for ${MINUTES} min, ${RATE} photo/guest/min`);
  // Look up the event with a throwaway sign-in.
  const probeApp = initializeApp(firebaseConfig, 'probe');
  const probeDb = getFirestore(probeApp);
  await signInAnonymously(getAuth(probeApp));
  const codeSnap = await getDoc(doc(probeDb, 'joinCodes', CODE)).catch((e) => { console.error('Could not read the join code:', e.code || e.message); process.exit(1); });
  if (!codeSnap.exists()) { console.error(`No event uses the code ${CODE}.`); process.exit(1); }
  const { eventId } = codeSnap.data();
  await deleteUser(getAuth(probeApp).currentUser).catch(() => {});
  await deleteApp(probeApp);

  // The event itself is readable once a guest has joined; the first guest reads it.
  const event = { id: eventId, autoApproval: true, expireAt: codeSnap.data().expireAt || null };

  const guests = [];
  const rampEach = (RAMP_S * 1000) / Math.max(GUESTS, 1);
  const ticker = setInterval(() => report(false), 15_000);
  for (let i = 0; i < GUESTS; i++) {
    const g = await guest(i, event);
    guests.push(g);
    if (i === 0 && g.alive) {
      const ev = await getDoc(doc(g.db, 'events', eventId)).catch(() => null);
      event.autoApproval = ev?.data()?.autoApproval === true;
      if (!event.autoApproval) console.warn('Heads up: auto-approval is OFF for this event, so photos wait for the host and "Shows up for others" stays empty.');
    }
    await sleep(rampEach);
  }
  const until = Date.now() + MINUTES * 60_000;
  await Promise.all(guests.filter((g) => g.alive).map((g) => partyLoop(g, event, until)));
  await sleep(5000); // let the last photos arrive
  clearInterval(ticker);
  report(true);

  const summary = {
    code: CODE, guests: GUESTS, minutes: MINUTES, rate: RATE, at: new Date().toISOString(),
    joined: m.joined, posted: m.posted, loves: m.loves, docsDelivered: m.docsDelivered, loveUpdates: m.loveUpdates,
    joinMs: { p50: pct(m.joinMs, 50), p95: pct(m.joinMs, 95) },
    uploadMs: { p50: pct(m.uploadMs, 50), p95: pct(m.uploadMs, 95) },
    saveMs: { p50: pct(m.writeMs, 50), p95: pct(m.writeMs, 95) },
    deliveryMs: { p50: pct(m.deliveryMs, 50), p95: pct(m.deliveryMs, 95) },
    loveMs: { p50: pct(m.loveMs, 50), p95: pct(m.loveMs, 95) },
    errors: m.errors,
  };
  const file = `results-${CODE}-${GUESTS}g-${Date.now()}.json`;
  writeFileSync(new URL(`./${file}`, import.meta.url), JSON.stringify(summary, null, 2));
  console.log(`\nSaved ${file}. Send it to Claude.`);

  console.log(KEEP ? 'Leaving the test photos and guests in place (--keep).' : 'Cleaning up test photos and pretend guests…');
  await Promise.all(guests.map((g) => cleanup(g, event)));
  console.log('Done.');
  process.exit(0);
})().catch((err) => {
  console.error('Load test stopped:', err);
  process.exit(1);
});

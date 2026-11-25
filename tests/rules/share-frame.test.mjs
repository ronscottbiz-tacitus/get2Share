// Firestore rules checks for the strip on shared photos ("shareFrame" on the event).
//
// Needs the Firestore emulator (Java 21+). From the repo root:
//   npm i --no-save firebase-tools @firebase/rules-unit-testing@5
//   npx firebase emulators:exec --only firestore --project demo-get2share "node tests/rules/share-frame.test.mjs"
//
// Every check prints PASS or FAIL; the script exits non-zero if any fail.
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-get2share',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
});

const EID = 'ev1';
let failed = 0;
async function check(name, p) {
  try { await p; console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}

async function seed(features) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'events', EID), {
      name: 'Party', ownerUid: 'owner', hostUids: ['owner', 'cohost'], joinCode: 'ABC123', access: 'link',
      autoApproval: true, guestLensEnabled: true, status: 'live', createdAt: Timestamp.now(),
    });
    await setDoc(doc(db, 'events', EID, 'members', 'maya'), { nickname: 'maya', joinedAt: Timestamp.now(), joinCode: 'ABC123', role: 'guest' });
    if (features) await setDoc(doc(db, 'features', EID), features);
  });
}

const account = (uid) => env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
const anon = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const event = (db) => doc(db, 'events', EID);

// --- A free event keeps the strip ---
await seed();
await check('a free event cannot turn the strip off', assertFails(updateDoc(event(account('owner')), { shareFrame: false })));
await check('a co-host of a free event cannot either', assertFails(updateDoc(event(account('cohost')), { shareFrame: false })));
await check('a free event can say the strip is on', assertSucceeds(updateDoc(event(account('owner')), { shareFrame: true })));
await check('the setting must be on or off', assertFails(updateDoc(event(account('owner')), { shareFrame: 'no' })));
await check('a guest cannot change it', assertFails(updateDoc(event(anon('maya')), { shareFrame: true })));
await check('a guest can read the event to see the setting', assertSucceeds(getDoc(event(anon('maya')))));
await check('other settings still work on a free event', assertSucceeds(updateDoc(event(account('owner')), { autoApproval: false })));

// --- A paid event can take it off ---
await seed({ flowSeconds: 60 });
await check('an event with paid Flow time can turn the strip off', assertSucceeds(updateDoc(event(account('owner')), { shareFrame: false })));
await check('and back on', assertSucceeds(updateDoc(event(account('owner')), { shareFrame: true })));
await check('a co-host of a paid event can turn it off', assertSucceeds(updateDoc(event(account('cohost')), { shareFrame: false })));

await seed({ pro: true });
await check('a Pro event can turn the strip off', assertSucceeds(updateDoc(event(account('owner')), { shareFrame: false })));

// --- Party and Big Event ---
await seed({ tier: 'big', upgraded: true, flowSeconds: 100, includedSeconds: 100 });
await check('a Big Event can turn the strip off', assertSucceeds(updateDoc(event(account('owner')), { shareFrame: false })));
await seed({ tier: 'party', upgraded: true, flowSeconds: 20, includedSeconds: 20 });
await check('a Party event keeps the strip (its seconds are included, not a pass)', assertFails(updateDoc(event(account('owner')), { shareFrame: false })));
await seed({ tier: 'party', upgraded: true, flowSeconds: 120, includedSeconds: 20 });
await check('a Party event with a Flow Pass can turn it off', assertSucceeds(updateDoc(event(account('owner')), { shareFrame: false })));

// --- Things that look paid but aren't ---
await seed({ flowSeconds: 0 });
await check('zero paid seconds is not paid', assertFails(updateDoc(event(account('owner')), { shareFrame: false })));
await seed({ keep: true });
await check('a features doc with nothing paid is not paid', assertFails(updateDoc(event(account('owner')), { shareFrame: false })));
await seed();
await check('a host cannot write the features doc to make the event paid', assertFails(setDoc(doc(account('owner'), 'features', EID), { pro: true })));

await env.cleanup();
process.exit(failed ? 1 : 0);

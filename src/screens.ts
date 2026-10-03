import { collection, deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc, Timestamp } from 'firebase/firestore';
import { db } from './firebase';
import { newCode } from './spotPairing';
import { paths } from './events';

// ---------- TV screens ----------
// A TV opens share.get2.one/tv and shows a short code. The host enters (or
// scans) that code in the Host Console, which ties the TV to one event. The
// TV then joins the event as a "screen" member and shows approved photos.
//
//   screenPairings/{CODE}           made by the TV; claimed once by a host
//   events/{eid}/screens/{tvUid}    per-screen settings the host controls

export const TV_PATH = '/tv';
export const SCREEN_CODE_TTL_MS = 15 * 60 * 1000;
export const STORED_SCREEN_KEY = 'get2share-screen-code';

export type ScreenLayout = 'wall' | 'justin' | 'slideshow';

export interface ScreenConfig {
  name: string;
  layout: ScreenLayout;
  showQr: boolean;
  showNames: boolean;
  paused: boolean;
  pairingCode: string;
  lastSeen?: Timestamp | null;
}

export interface ScreenPairing {
  screenUid: string;
  createdAt: Timestamp | null;
  eventId: string | null;
  screenName: string | null;
  claimedBy: string | null;
}

export const screenPaths = {
  pairing: (code: string) => doc(db, 'screenPairings', code),
  screens: (eid: string) => collection(db, 'events', eid, 'screens'),
  screen: (eid: string, uid: string) => doc(db, 'events', eid, 'screens', uid),
};

export const LAYOUTS: { id: ScreenLayout; label: string; hint: string }[] = [
  { id: 'wall', label: 'Wall', hint: 'A mosaic of the newest photos' },
  { id: 'justin', label: 'Just in', hint: 'The newest photo, big' },
  { id: 'slideshow', label: 'Slideshow', hint: 'Every photo, one at a time' },
];

/** TV side: make a fresh code for this TV to show. */
export async function createScreenCode(uid: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    try {
      await setDoc(screenPaths.pairing(code), {
        screenUid: uid,
        createdAt: serverTimestamp(),
        eventId: null,
        screenName: null,
        claimedBy: null,
      });
      return code;
    } catch (err) {
      lastErr = err; // code taken: try another
    }
  }
  throw lastErr;
}

/** Host side: connect the TV showing `code` to an event. */
export async function claimScreen(code: string, eid: string, hostUid: string, name: string) {
  const ref = screenPaths.pairing(code);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not-found');
  const p = snap.data() as ScreenPairing;
  if (p.claimedBy) throw new Error('already-claimed');
  await updateDoc(ref, { eventId: eid, claimedBy: hostUid, screenName: name, claimedAt: serverTimestamp() });
  await setDoc(screenPaths.screen(eid, p.screenUid), {
    name,
    layout: 'wall',
    showQr: true,
    showNames: true,
    paused: false,
    pairingCode: code,
  } satisfies Omit<ScreenConfig, 'lastSeen'>);
}

/** Host side: disconnect a TV. It goes back to showing a new code. */
export async function removeScreen(eid: string, tvUid: string, code: string) {
  await deleteDoc(screenPaths.screen(eid, tvUid)).catch(() => {});
  await deleteDoc(paths.member(eid, tvUid)).catch(() => {});
  if (code) await deleteDoc(screenPaths.pairing(code)).catch(() => {});
}

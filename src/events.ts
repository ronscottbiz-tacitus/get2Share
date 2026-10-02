import {
  collection, doc, getDoc, serverTimestamp, setDoc, updateDoc, writeBatch, Timestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { newCode, normalizePairingCode } from './spotPairing';

// Everything for one event lives under events/{eventId}. These helpers are the
// only place that knows the layout (mirrors firestore.rules).

export interface EventDoc {
  name: string;
  subtitle?: string;
  ownerUid: string;
  hostUids: string[];
  joinCode: string;
  access: 'link' | 'list';
  autoApproval: boolean;
  guestLensEnabled: boolean;
  status: 'live' | 'wrapup' | 'album' | 'archived';
  createdAt: Timestamp | null;
  startsAt?: Timestamp | null;
  endsAt?: Timestamp | null;
}

export interface EventWithId extends EventDoc {
  id: string;
}

export const paths = {
  event: (eid: string) => doc(db, 'events', eid),
  events: () => collection(db, 'events'),
  joinCode: (code: string) => doc(db, 'joinCodes', code),
  member: (eid: string, uid: string) => doc(db, 'events', eid, 'members', uid),
  photos: (eid: string) => collection(db, 'events', eid, 'photos'),
  photo: (eid: string, id: string) => doc(db, 'events', eid, 'photos', id),
  sessions: (eid: string) => collection(db, 'events', eid, 'sessions'),
  session: (eid: string, uid: string) => doc(db, 'events', eid, 'sessions', uid),
  console: (eid: string) => doc(db, 'events', eid, 'live', 'console'),
};

export const EVENT_PATH_PREFIX = '/e/';
export const HOST_PATH = '/host';

export function joinUrl(code: string) {
  return `${window.location.origin}${EVENT_PATH_PREFIX}${code}`;
}

export const normalizeJoinCode = normalizePairingCode;

/** Last event this device joined, so share.get2.one can offer "Back to …". */
export const LAST_EVENT_KEY = 'get2share-last-event';
export interface LastEvent { code: string; name: string }

export function rememberEvent(e: LastEvent) {
  try { localStorage.setItem(LAST_EVENT_KEY, JSON.stringify(e)); } catch { /* ignore */ }
}

export function readLastEvent(): LastEvent | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_EVENT_KEY) || 'null');
    return v && typeof v.code === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** CODE → { eventId, name }, or null if no event uses that code (any more). */
export async function resolveJoinCode(code: string): Promise<{ eventId: string; name: string } | null> {
  const snap = await getDoc(paths.joinCode(code));
  if (!snap.exists()) return null;
  const d = snap.data() as { eventId: string; name: string };
  return { eventId: d.eventId, name: d.name || 'Get2Share event' };
}

/** Create an event owned by `uid`, with a fresh join code. Returns its ID. */
export async function createEvent(
  uid: string,
  input: { name: string; subtitle?: string; autoApproval: boolean }
): Promise<{ id: string; code: string }> {
  const ref = doc(paths.events());
  let lastErr: unknown;
  // A code collision fails the batch; just try another code.
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    const batch = writeBatch(db);
    const data: Omit<EventDoc, 'createdAt'> & { createdAt: unknown } = {
      name: input.name.trim(),
      subtitle: (input.subtitle || '').trim(),
      ownerUid: uid,
      hostUids: [uid],
      joinCode: code,
      access: 'link',
      autoApproval: input.autoApproval,
      guestLensEnabled: true,
      status: 'live',
      createdAt: serverTimestamp(),
    };
    batch.set(ref, data);
    batch.set(paths.joinCode(code), { eventId: ref.id, name: data.name });
    try {
      await batch.commit();
      return { id: ref.id, code };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Join as a guest (or update the nickname if this device already joined). */
export async function joinEvent(eid: string, uid: string, nickname: string, code: string) {
  const ref = paths.member(eid, uid);
  let exists = false;
  try {
    exists = (await getDoc(ref)).exists();
  } catch {
    exists = false; // not readable = not a member yet
  }
  if (exists) {
    await updateDoc(ref, { nickname });
  } else {
    await setDoc(ref, { nickname, joinedAt: serverTimestamp(), joinCode: code, role: 'guest' });
  }
}

export async function isMemberOf(eid: string, uid: string): Promise<boolean> {
  try {
    return (await getDoc(paths.member(eid, uid))).exists();
  } catch {
    return false;
  }
}

/** New join link: the old one stops working; people already in stay in. */
export async function resetJoinCode(eid: string, oldCode: string, name: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    const batch = writeBatch(db);
    batch.set(paths.joinCode(code), { eventId: eid, name });
    batch.update(paths.event(eid), { joinCode: code });
    if (oldCode) batch.delete(paths.joinCode(oldCode));
    try {
      await batch.commit();
      return code;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Rename (and re-subtitle) an event; keeps the join-code lookup in sync. */
export async function saveEventDetails(eid: string, code: string, name: string, subtitle: string) {
  const batch = writeBatch(db);
  batch.update(paths.event(eid), { name: name.trim(), subtitle: subtitle.trim() });
  batch.update(paths.joinCode(code), { name: name.trim() });
  await batch.commit();
}

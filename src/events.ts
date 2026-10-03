import {
  collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc, writeBatch, Timestamp,
} from 'firebase/firestore';
import { db, deletePhotoFile } from './firebase';
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
  /** When the album closes and everything for this event is cleaned up. */
  expireAt?: Timestamp | null;
}

export interface EventWithId extends EventDoc {
  id: string;
}

// ---------- Lifecycle ----------
//   live     until the end time
//   wrapup   1 hour after the end: last uploads still land, Share Spots are off
//   album    30 days after the end: view, react, save; no new photos
//   expired  the cleanup removes it

export const UPLOAD_GRACE_MS = 60 * 60 * 1000;
export const ALBUM_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type EventPhase = 'live' | 'wrapup' | 'album' | 'expired';

export function eventPhase(ev: Pick<EventDoc, 'endsAt' | 'expireAt'>, now = Date.now()): EventPhase {
  const end = ev.endsAt?.toMillis?.();
  if (!end || now < end) return 'live';
  if (now < end + UPLOAD_GRACE_MS) return 'wrapup';
  const exp = ev.expireAt?.toMillis?.() ?? end + ALBUM_DAYS * DAY_MS;
  return now < exp ? 'album' : 'expired';
}

/** endsAt and the matching cleanup date (the rules check they line up). */
export function endTimes(end: Date) {
  return {
    endsAt: Timestamp.fromDate(end),
    expireAt: Timestamp.fromMillis(end.getTime() + ALBUM_DAYS * DAY_MS),
  };
}

/** Default end time for a new event: 5 hours from now, on the hour. */
export function defaultEnd(): Date {
  const d = new Date(Date.now() + 5 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d;
}

/** Change (or set) when an event ends. Also used for "End now" and "Reopen". */
export async function setEventEnd(eid: string, code: string, end: Date) {
  const t = endTimes(end);
  const batch = writeBatch(db);
  batch.update(paths.event(eid), t);
  batch.update(paths.joinCode(code), { expireAt: t.expireAt });
  await batch.commit();
}

export function formatWhen(ms: number) {
  return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatDay(ms: number) {
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** <input type="datetime-local"> value for a Date, in local time. */
export function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  joined: (uid: string) => collection(db, 'users', uid, 'joined'),
  joinedEvent: (uid: string, eid: string) => doc(db, 'users', uid, 'joined', eid),
};

export const EVENT_PATH_PREFIX = '/e/';
export const HOST_PATH = '/host';

export function joinUrl(code: string) {
  return `${window.location.origin}${EVENT_PATH_PREFIX}${code}`;
}

export const normalizeJoinCode = normalizePairingCode;

/** Events this device joined, so share.get2.one can offer "Back to …" and a
 *  member can follow an event to a new join code after the host resets it. */
export const LAST_EVENT_KEY = 'get2share-last-event';
const JOINED_KEY = 'get2share-joined-events';
export interface LastEvent { code: string; name: string; eventId?: string }

function readJoined(): LastEvent[] {
  try {
    const v = JSON.parse(localStorage.getItem(JOINED_KEY) || '[]');
    return Array.isArray(v) ? v.filter((e) => e && typeof e.code === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberEvent(e: LastEvent) {
  try {
    localStorage.setItem(LAST_EVENT_KEY, JSON.stringify(e));
    const others = readJoined().filter((x) => (e.eventId ? x.eventId !== e.eventId : x.code !== e.code));
    localStorage.setItem(JOINED_KEY, JSON.stringify([e, ...others].slice(0, 20)));
  } catch { /* ignore */ }
}

export function readLastEvent(): LastEvent | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_EVENT_KEY) || 'null');
    return v && typeof v.code === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** An event this device joined under `code` (the code may have changed since). */
export function findJoinedByCode(code: string): LastEvent | null {
  const last = readLastEvent();
  if (last?.code === code && last.eventId) return last;
  return readJoined().find((e) => e.code === code && e.eventId) || null;
}

/** CODE → { eventId, name }, or null if no event uses that code (any more). */
export interface JoinInfo { eventId: string; name: string; expireAt: Timestamp | null }

export async function resolveJoinCode(code: string): Promise<JoinInfo | null> {
  const snap = await getDoc(paths.joinCode(code));
  if (!snap.exists()) return null;
  const d = snap.data() as { eventId: string; name: string; expireAt?: Timestamp };
  return { eventId: d.eventId, name: d.name || 'Get2Share event', expireAt: d.expireAt ?? null };
}

/** Create an event owned by `uid`, with a fresh join code. Returns its ID. */
export async function createEvent(
  uid: string,
  input: { name: string; subtitle?: string; autoApproval: boolean; end: Date }
): Promise<{ id: string; code: string }> {
  const times = endTimes(input.end);
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
      ...times,
    };
    batch.set(ref, data);
    batch.set(paths.joinCode(code), { eventId: ref.id, name: data.name, expireAt: times.expireAt });
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
export async function joinEvent(
  eid: string, uid: string, nickname: string, code: string, name: string, expireAt: Timestamp | null
) {
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
    await setDoc(ref, {
      nickname, joinedAt: serverTimestamp(), joinCode: code, role: 'guest',
      ...(expireAt ? { expireAt } : {}),
    });
  }
  await recordJoined(uid, eid, { name, code, expireAt });
}

/** This device's list of events it joined (kept with the account once saved). */
export async function recordJoined(uid: string, eid: string, info: { name: string; code: string; expireAt: Timestamp | null }) {
  await setDoc(
    paths.joinedEvent(uid, eid),
    { name: info.name, code: info.code, joinedAt: serverTimestamp(), ...(info.expireAt ? { expireAt: info.expireAt } : {}) },
    { merge: true }
  ).catch((e) => console.warn('Could not record joined event:', e));
}

export async function isMemberOf(eid: string, uid: string): Promise<boolean> {
  try {
    return (await getDoc(paths.member(eid, uid))).exists();
  } catch {
    return false;
  }
}

/** New join link: the old one stops working; people already in stay in. */
export async function resetJoinCode(
  eid: string, oldCode: string, name: string, expireAt?: Timestamp | null
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    const batch = writeBatch(db);
    batch.set(paths.joinCode(code), { eventId: eid, name, ...(expireAt ? { expireAt } : {}) });
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

/** Fields every photo/session in an event carries so the cleanup removes it with the album. */
export function expiryOf(ev: { expireAt?: Timestamp | null } | null | undefined) {
  return ev?.expireAt ? { expireAt: ev.expireAt } : {};
}

/** Delete an event and everything in it. Order matters: the rules check the
 *  event to confirm you host it, so the event itself goes last. */
export async function deleteEvent(ev: EventWithId, progress: (msg: string) => void = () => {}) {
  const eid = ev.id;
  const photos = await getDocs(paths.photos(eid));
  let n = 0;
  for (const d of photos.docs) {
    const url = (d.data() as any).url as string;
    await deleteDoc(d.ref);
    await deletePhotoFile(url); // before the event goes: Storage checks the event to allow it
    n++;
    if (n % 5 === 0 || n === photos.size) progress(`Deleting photos… ${n} of ${photos.size}`);
  }
  progress('Removing guests and devices…');
  const sessions = await getDocs(paths.sessions(eid));
  await Promise.all(sessions.docs.map((d) => deleteDoc(d.ref)));
  const members = await getDocs(collection(db, 'events', eid, 'members'));
  await Promise.all(members.docs.map((d) => deleteDoc(d.ref)));
  if (ev.joinCode) await deleteDoc(paths.joinCode(ev.joinCode)).catch(() => {});
  progress('Removing the event…');
  await deleteDoc(paths.event(eid));
}

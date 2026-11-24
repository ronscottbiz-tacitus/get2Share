import {
  arrayRemove, arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch, Timestamp,
} from 'firebase/firestore';
import { db, deletePhotoFile } from './firebase';
import { newCode } from './spotPairing';

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
  /** The latest Group Shot the host fired (see groupShot.ts). */
  groupShot?: { id: string; firesAt: Timestamp; by: string; spots?: boolean } | null;
  /** Guests can borrow each other's cameras (see guestLens.ts). Off unless the host turns it on. */
  lensSharing?: boolean;
  /** When guests can save other people's photos to their devices (see savePhotos.ts). Unset = any time. */
  albumSaving?: 'party' | 'after' | 'host';
  /** Shared photos carry a strip with the event's name and share.get2.one (see shareFrame.ts).
   *  On unless this is false, and the rules only let a paid event set it to false. */
  shareFrame?: boolean;
  /** Co-hosts may make and redo Flow videos (spending the event's AI seconds). Off unless the owner turns it on. */
  flowCohosts?: boolean;
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
  hostInvites: (eid: string) => collection(db, 'events', eid, 'hostInvites'),
  hostInvite: (eid: string, token: string) => doc(db, 'events', eid, 'hostInvites', token),
  hostClaims: (eid: string) => collection(db, 'events', eid, 'hostClaims'),
  hostClaim: (eid: string, uid: string) => doc(db, 'events', eid, 'hostClaims', uid),
  blocked: (eid: string) => collection(db, 'events', eid, 'blocked'),
  blockedGuest: (eid: string, uid: string) => doc(db, 'events', eid, 'blocked', uid),
  photos: (eid: string) => collection(db, 'events', eid, 'photos'),
  photo: (eid: string, id: string) => doc(db, 'events', eid, 'photos', id),
  sessions: (eid: string) => collection(db, 'events', eid, 'sessions'),
  session: (eid: string, uid: string) => doc(db, 'events', eid, 'sessions', uid),
  console: (eid: string) => doc(db, 'events', eid, 'live', 'console'),
  joined: (uid: string) => collection(db, 'users', uid, 'joined'),
  people: (eid: string) => collection(db, 'events', eid, 'people'),
  person: (eid: string, uid: string) => doc(db, 'events', eid, 'people', uid),
  lensRequest: (eid: string, ownerUid: string) => doc(db, 'events', eid, 'lensRequests', ownerUid),
  joinedEvent: (uid: string, eid: string) => doc(db, 'users', uid, 'joined', eid),
};

export * from './eventLinks';
import { EVENT_PATH_PREFIX, HOST_PATH } from './eventLinks';

export function joinUrl(code: string) {
  return `${window.location.origin}${EVENT_PATH_PREFIX}${code}`;
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

// ---------- Co-hosts ----------

// Co-hosts are free on every event, with no limit on how many.
export const HOST_INVITE_HOURS = 24;
export const HOST_INVITE_MS = HOST_INVITE_HOURS * 60 * 60 * 1000;
export const COHOST_PARAM = 'cohost';

export interface HostInvite {
  createdBy: string;
  createdAt: Timestamp | null;
  eventName: string;
  claimedBy: string | null;
  claimedAt?: Timestamp | null;
}

export interface HostClaim { token: string; name: string; email: string }

function newInviteToken() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** The link the owner sends: /host?cohost=EVENTID.TOKEN */
export function hostInviteUrl(eid: string, token: string) {
  return `${window.location.origin}${HOST_PATH}?${COHOST_PARAM}=${eid}.${token}`;
}

export function parseHostInvite(value: string | null): { eventId: string; token: string } | null {
  const m = /^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{20,64})$/.exec(value || '');
  return m ? { eventId: m[1], token: m[2] } : null;
}

/** When an invite stops working. A link made a moment ago has no server time yet: count from now. */
export function hostInviteExpiry(inv: Pick<HostInvite, 'createdAt'>) {
  return (inv.createdAt ? inv.createdAt.toMillis() : Date.now()) + HOST_INVITE_MS;
}

/** Owner: make a one-time co-host link. Returns its token. */
export async function createHostInvite(ev: EventWithId, ownerUid: string): Promise<string> {
  const token = newInviteToken();
  await setDoc(paths.hostInvite(ev.id, token), {
    createdBy: ownerUid,
    createdAt: serverTimestamp(),
    eventName: ev.name.slice(0, 80),
    claimedBy: null,
    ...expiryOf(ev),
  });
  return token;
}

export async function cancelHostInvite(eid: string, token: string) {
  await deleteDoc(paths.hostInvite(eid, token));
}

export type AcceptInviteResult = 'joined' | 'already' | 'gone' | 'used' | 'expired' | 'failed';

/** Accept a co-host link as the signed-in account. One write: claim the invite, record who
 *  claimed it, and join the event's hosts. */
export async function acceptHostInvite(
  eid: string, token: string, me: { uid: string; name: string; email: string }
): Promise<{ result: AcceptInviteResult; eventName?: string }> {
  let inv: HostInvite | null = null;
  try {
    const snap = await getDoc(paths.hostInvite(eid, token));
    inv = snap.exists() ? (snap.data() as HostInvite) : null;
  } catch {
    return { result: 'failed' };
  }
  // Already a host of this event (the owner opening their own link, or a second tap).
  try {
    const ev = await getDoc(paths.event(eid));
    if (ev.exists() && ((ev.data() as EventDoc).hostUids || []).includes(me.uid)) {
      return { result: 'already', eventName: (ev.data() as EventDoc).name };
    }
  } catch { /* not readable = not a host yet */ }
  if (!inv) return { result: 'gone' };
  if (inv.claimedBy) return { result: 'used', eventName: inv.eventName };
  if (Date.now() >= hostInviteExpiry(inv)) return { result: 'expired', eventName: inv.eventName };
  try {
    const batch = writeBatch(db);
    batch.update(paths.hostInvite(eid, token), { claimedBy: me.uid, claimedAt: serverTimestamp() });
    batch.set(paths.hostClaim(eid, me.uid), {
      token,
      claimedAt: serverTimestamp(),
      name: (me.name || '').slice(0, 80),
      email: me.email,
    });
    batch.update(paths.event(eid), { hostUids: arrayUnion(me.uid) });
    await batch.commit();
    return { result: 'joined', eventName: inv.eventName };
  } catch (err) {
    console.error('Accepting the co-host invite failed:', err);
    return { result: 'failed', eventName: inv.eventName };
  }
}

/** Owner: let co-hosts make and redo Flow videos, or keep that to the owner. */
export async function setFlowCohosts(eid: string, on: boolean) {
  await updateDoc(paths.event(eid), { flowCohosts: on });
}

/** Owner: take a co-host off the event. */
export async function removeCohost(eid: string, uid: string) {
  await updateDoc(paths.event(eid), { hostUids: arrayRemove(uid) });
  await deleteDoc(paths.hostClaim(eid, uid)).catch(() => {});
}

// ---------- Removing and blocking guests ----------

/** Take a guest out of the event. Their phone goes back to the join screen; they can
 *  rejoin with the code. Their photos stay. */
export async function removeGuest(eid: string, uid: string) {
  // Membership first: that is what ends their access. The rest is tidying up.
  await deleteDoc(paths.member(eid, uid));
  await Promise.all([
    deleteDoc(paths.session(eid, uid)).catch(() => {}),
    deleteDoc(paths.person(eid, uid)).catch(() => {}),
    deleteDoc(paths.lensRequest(eid, uid)).catch(() => {}),
  ]);
}

/** Remove a guest and stop that device from joining this event again.
 *  hidePhotos also takes their photos out of the gallery (they are kept, not deleted).
 *  Returns how many photos were hidden. */
export async function blockGuest(
  eid: string, uid: string, nickname: string, byUid: string,
  opts: { hidePhotos: boolean; expireAt?: Timestamp | null }
): Promise<number> {
  // Block first, so there is no moment where they are out but could walk back in.
  await setDoc(paths.blockedGuest(eid, uid), {
    nickname: (nickname || 'Guest').slice(0, 64),
    blockedAt: serverTimestamp(),
    by: byUid,
    ...(opts.expireAt ? { expireAt: opts.expireAt } : {}),
  });
  await removeGuest(eid, uid);
  if (!opts.hidePhotos) return 0;
  const theirs = await getDocs(query(paths.photos(eid), where('sessionId', '==', uid)));
  const visible = theirs.docs.filter((d) => (d.data() as any).status !== 'rejected');
  await Promise.all(visible.map((d) => updateDoc(d.ref, { status: 'rejected' })));
  return visible.length;
}

/** Let a blocked device join again (it still has to join with the code). */
export async function unblockGuest(eid: string, uid: string) {
  await deleteDoc(paths.blockedGuest(eid, uid));
}

export async function isBlockedFrom(eid: string, uid: string): Promise<boolean> {
  try {
    return (await getDoc(paths.blockedGuest(eid, uid))).exists();
  } catch {
    return false;
  }
}

// A blocked device remembers it, so "Join as someone new" (a fresh guest identity on the
// same phone) doesn't walk around the block. Clearing the browser's data still does.
const BLOCKED_KEY = 'get2share-blocked';

function readBlockedHere(): { eventId: string; uid: string }[] {
  try {
    const v = JSON.parse(localStorage.getItem(BLOCKED_KEY) || '[]');
    return Array.isArray(v) ? v.filter((b) => b && typeof b.eventId === 'string' && typeof b.uid === 'string') : [];
  } catch {
    return [];
  }
}

function writeBlockedHere(list: { eventId: string; uid: string }[]) {
  try { localStorage.setItem(BLOCKED_KEY, JSON.stringify(list.slice(-50))); } catch { /* ignore */ }
}

/** Is this device blocked from the event, as the current guest or as an earlier one on this phone? */
export async function deviceBlockedFrom(eid: string, uid: string): Promise<boolean> {
  if (await isBlockedFrom(eid, uid)) {
    const list = readBlockedHere();
    if (!list.some((b) => b.eventId === eid && b.uid === uid)) writeBlockedHere([...list, { eventId: eid, uid }]);
    return true;
  }
  const earlier = readBlockedHere().filter((b) => b.eventId === eid && b.uid !== uid);
  let blocked = false;
  for (const b of earlier) {
    if (await isBlockedFrom(eid, b.uid)) { blocked = true; break; }
  }
  // The host unblocked them (or the event is gone): forget it here too.
  if (!blocked && readBlockedHere().some((b) => b.eventId === eid)) {
    writeBlockedHere(readBlockedHere().filter((b) => b.eventId !== eid));
  }
  return blocked;
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
  const blocked = await getDocs(paths.blocked(eid)).catch(() => null);
  if (blocked) await Promise.all(blocked.docs.map((d) => deleteDoc(d.ref)));
  for (const col of [paths.hostInvites(eid), paths.hostClaims(eid)]) {
    const docs = await getDocs(col).catch(() => null);
    if (docs) await Promise.all(docs.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
  }
  if (ev.joinCode) await deleteDoc(paths.joinCode(ev.joinCode)).catch(() => {});
  progress('Removing the event…');
  await deleteDoc(paths.event(eid));
}

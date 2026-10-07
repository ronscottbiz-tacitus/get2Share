import { Timestamp, deleteDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { paths } from './events';

// Guests borrowing each other's cameras ("Borrow").
//
//   1. Maya taps Borrow, picks Jordan → lensRequests/{jordan} = asking
//   2. Jordan's phone shows "Maya wants to use your camera" → Yes (live) or No (declined)
//   3. While live, Jordan's phone sends a small preview every 1.5s; Maya sees it
//   4. Maya taps the shutter → shot = { id, firesAt }. Both phones count down to firesAt,
//      Jordan's phone takes the photo, uploads it as "maya on jordan's phone"
//      (takenBy = Maya), and confirms with lastShotId
//   5. Either of them stops (ended), or it times out
//
// The doc ID is the camera owner's uid, so one camera serves one person at a time.
// firestore.rules enforce who may write what; this file is the only place that
// writes these docs. Only while the host has turned on event.lensSharing.

export type LensStatus = 'asking' | 'live' | 'declined' | 'ended';

/** Why a session ended, so both phones can say it in plain words. */
export type LensEndReason =
  | 'cancelled' // the asker gave up waiting
  | 'noanswer' // nobody answered in time
  | 'stopped' // the camera owner stopped sharing
  | 'closed' // the asker closed the camera
  | 'away' // the owner's phone locked or left the page
  | 'idle' // no shots for a while
  | 'lost' // the asker's phone stopped hearing the camera
  | 'groupshot' // a Group Shot started; it goes first
  | 'camera' // the owner's camera wouldn't open
  | 'host'; // a host ended it

export interface LensShot {
  id: string;
  firesAt: Timestamp;
}

export interface LensRequest {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  status: LensStatus;
  endReason?: LensEndReason | null;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  frame?: string | null;
  frameAt?: Timestamp | null;
  shot?: LensShot | null;
  lastShotId?: string | null;
}

/** How long a request waits for a yes before it gives up. */
export const ASK_TIMEOUT_MS = 30_000;
/** Preview frames from the owner's phone. */
export const FRAME_EVERY_MS = 1_500;
/** No new frame for this long: the asker shows "camera paused". */
export const FRAME_STALE_MS = 8_000;
/** No new frame for this long: the asker gives up. */
export const FRAME_LOST_MS = 25_000;
/** A live session with no shots ends after this long. */
export const IDLE_END_MS = 120_000;
/** Lead time from the tap to the shot. Covers the trip to the other phone. */
export const SHOT_LEAD_MS = 3_500;
/** People who checked in within this window show in the Borrow list. */
export const PRESENT_MS = 3 * 60_000;
/** How often a guest checks in while lensSharing is on. */
export const HEARTBEAT_MS = 60_000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s) || 'guest';

export const millis = (t: Timestamp | null | undefined) => t?.toMillis?.() ?? 0;

/** "maya on jordan's phone": the photo's credit, shown everywhere nicknames are. */
export function lensCredit(fromName: string, toName: string) {
  return clip(`${fromName} on ${toName}'s phone`, 64);
}

/** When the owner's phone should fire, on its own clock. Trusts firesAt unless the clocks disagree a lot. */
export function fireTimeOnThisPhone(shot: LensShot, now = Date.now()) {
  const at = millis(shot.firesAt);
  const lead = at - now;
  return lead >= 1_200 && lead <= 8_000 ? at : now + 2_500;
}

// ---------- Who's here ----------

export function checkIn(eid: string, uid: string, nickname: string, expire: object) {
  return setDoc(paths.person(eid, uid), { nickname: clip(nickname, 40), lastSeen: serverTimestamp(), ...expire });
}

export function checkOut(eid: string, uid: string) {
  return deleteDoc(paths.person(eid, uid));
}

// ---------- The asker ----------

export function askCamera(
  eid: string, me: { uid: string; name: string }, owner: { uid: string; name: string }, expire: object
) {
  return setDoc(paths.lensRequest(eid, owner.uid), {
    from: me.uid,
    fromName: clip(me.name, 40),
    to: owner.uid,
    toName: clip(owner.name, 40),
    status: 'asking',
    endReason: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    frame: null,
    shot: null,
    lastShotId: null,
    ...expire,
  });
}

export function fireShot(eid: string, ownerUid: string): Promise<LensShot> {
  const shot: LensShot = {
    id: `ls_${Date.now().toString(36)}`,
    firesAt: Timestamp.fromMillis(Date.now() + SHOT_LEAD_MS),
  };
  return updateDoc(paths.lensRequest(eid, ownerUid), { shot, updatedAt: serverTimestamp() }).then(() => shot);
}

export function askerEnd(eid: string, ownerUid: string, reason: LensEndReason) {
  return updateDoc(paths.lensRequest(eid, ownerUid), {
    status: 'ended', endReason: reason, shot: null, frame: null, updatedAt: serverTimestamp(),
  });
}

// ---------- The camera owner ----------

export function ownerAccept(eid: string, ownerUid: string) {
  return updateDoc(paths.lensRequest(eid, ownerUid), { status: 'live', updatedAt: serverTimestamp() });
}

export function ownerDecline(eid: string, ownerUid: string) {
  return updateDoc(paths.lensRequest(eid, ownerUid), { status: 'declined', updatedAt: serverTimestamp() });
}

export function ownerEnd(eid: string, ownerUid: string, reason: LensEndReason) {
  return updateDoc(paths.lensRequest(eid, ownerUid), {
    status: 'ended', endReason: reason, frame: null, updatedAt: serverTimestamp(),
  });
}

export function ownerFrame(eid: string, ownerUid: string, frame: string) {
  return updateDoc(paths.lensRequest(eid, ownerUid), {
    frame, frameAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
}

export function ownerShotDone(eid: string, ownerUid: string, shotId: string) {
  return updateDoc(paths.lensRequest(eid, ownerUid), { lastShotId: shotId, updatedAt: serverTimestamp() });
}

/** What the asker's phone says when a session ends. */
export function endedMessage(reason: LensEndReason | null | undefined, owner: string): string {
  switch (reason) {
    case 'stopped': return `${owner} stopped sharing their camera.`;
    case 'away': return `${owner}'s phone went to sleep, so the camera closed.`;
    case 'idle': return 'The camera closed after two quiet minutes.';
    case 'groupshot': return 'Paused for the Group Shot. Ask again after.';
    case 'camera': return `${owner}'s camera wouldn't open.`;
    case 'host': return 'The host ended camera sharing.';
    case 'lost': return `Lost touch with ${owner}'s camera.`;
    case 'noanswer': return `${owner} didn't answer. Try again in a bit.`;
    default: return 'Camera closed.';
  }
}

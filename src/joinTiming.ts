import { useEffect, useState } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

// Join timer: how long each step of opening an event link takes on this phone, so a slow
// join shows where the time went. Times are milliseconds since the page started loading.
//
//   opened      the app's code started running (download + startup)
//   signedIn    Firebase sign-in finished ("Connecting…" ends)
//   codeFound   the join code was looked up ("Finding the event…", part 1)
//   member      checked whether this phone already joined ("Finding the event…", part 2)
//   nameScreen  a new guest sees the name screen (then waits on them typing)
//   joined      a new guest's join went through
//   gallery     the gallery is on screen
//
// Saved once per phone per event to events/{eid}/timings/{uid}; hosts see them in the
// Host Console under "Join speed". Add ?timing=1 to any link to watch it live on screen.

export type JoinStep = 'opened' | 'signedIn' | 'codeFound' | 'member' | 'nameScreen' | 'joined' | 'gallery';
export const JOIN_STEPS: { key: JoinStep; label: string }[] = [
  { key: 'opened', label: 'App loaded' },
  { key: 'signedIn', label: 'Signed in' },
  { key: 'codeFound', label: 'Found event' },
  { key: 'member', label: 'Checked guest list' },
  { key: 'nameScreen', label: 'Name screen' },
  { key: 'joined', label: 'Joined' },
  { key: 'gallery', label: 'Gallery' },
];

const marks: Partial<Record<JoinStep, number>> = {};
const notes: Record<string, string> = {};
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

/** Record when a step finished (first time only). */
export function markJoin(step: JoinStep) {
  if (marks[step] !== undefined) return;
  marks[step] = Math.round(performance.now());
  changed();
}

/** Extra facts for the record (e.g. whether sign-in was new or remembered). */
export function noteJoin(key: string, value: string) {
  notes[key] = value.slice(0, 40);
  changed();
}

/** Like noteJoin, but keeps an earlier value. */
export function noteJoinOnce(key: string, value: string) {
  if (!(key in notes)) noteJoin(key, value);
}

/** Show the on-screen timer: ?timing=1 turns it on for this tab, ?timing=0 off. */
export function timingOverlayOn(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('timing');
    if (q === '1') sessionStorage.setItem('get2share-timing', '1');
    if (q === '0') sessionStorage.removeItem('get2share-timing');
    return sessionStorage.getItem('get2share-timing') === '1';
  } catch {
    return false;
  }
}

export function useJoinMarks() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    const t = setInterval(f, 500); // keep the "waiting" clock moving
    return () => { listeners.delete(f); clearInterval(t); };
  }, []);
  return { marks: { ...marks }, notes: { ...notes }, now: Math.round(performance.now()) };
}

function network(): string {
  const c = (navigator as any).connection;
  return [c?.effectiveType, c?.downlink ? `${c.downlink}Mbps` : ''].filter(Boolean).join(' ') || 'unknown';
}

function device(): string {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+)_(\d+)/);
  if (/iPhone|iPad/.test(ua)) return `${/iPad/.test(ua) ? 'iPad' : 'iPhone'} iOS ${ios ? `${ios[1]}.${ios[2]}` : ''}${/CriOS/.test(ua) ? ' Chrome' : ' Safari'}`;
  const android = ua.match(/Android (\d+)/);
  if (android) return `Android ${android[1]}${/Chrome/.test(ua) ? ' Chrome' : ''}`;
  if (/Macintosh/.test(ua)) return `Mac ${/Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : ''}`;
  return ua.slice(0, 40);
}

let saved = false;
/** Save this phone's join timings for the host. Once per page load; never throws. */
export async function saveJoinTiming(eid: string, uid: string, nickname: string, expireAt: Timestamp | null) {
  if (saved || marks.gallery === undefined) return;
  saved = true;
  try {
    await setDoc(doc(db, 'events', eid, 'timings', uid), {
      nickname: (nickname || 'Guest').slice(0, 40),
      steps: { ...marks },
      notes: { ...notes },
      device: device().slice(0, 60),
      network: network().slice(0, 40),
      at: serverTimestamp(),
      ...(expireAt ? { expireAt } : {}),
    });
  } catch {
    /* timing is best-effort */
  }
}

export interface JoinTimingRecord {
  id: string;
  nickname: string;
  steps: Partial<Record<JoinStep, number>>;
  notes?: Record<string, string>;
  device?: string;
  network?: string;
  at?: { toMillis(): number } | null;
}

/** Host Console: the latest joins for this event. */
export function useJoinTimings(eid: string, enabled: boolean): JoinTimingRecord[] {
  const [rows, setRows] = useState<JoinTimingRecord[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const q = query(collection(db, 'events', eid, 'timings'), orderBy('at', 'desc'), limit(20));
    return onSnapshot(q, (s) => setRows(s.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))), () => setRows([]));
  }, [eid, enabled]);
  return rows;
}

/** Each step's own duration: time since the step before it that happened. */
export function stepDurations(steps: Partial<Record<JoinStep, number>>) {
  let prev = 0;
  return JOIN_STEPS.filter((s) => steps[s.key] !== undefined).map((s) => {
    const at = steps[s.key]!;
    const d = { ...s, at, ms: Math.max(0, at - prev) };
    prev = at;
    return d;
  });
}

/** Time the guest was waiting on the app (excludes typing their name). */
export function waitingMs(steps: Partial<Record<JoinStep, number>>) {
  const ready = steps.nameScreen ?? steps.gallery;
  if (ready === undefined) return null;
  const typing = steps.nameScreen !== undefined && steps.joined !== undefined ? steps.joined - steps.nameScreen : 0;
  const end = steps.gallery ?? ready;
  return Math.max(0, end - typing);
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

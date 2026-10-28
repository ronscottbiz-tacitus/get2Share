// Join links and the "events this device joined" list. No Firebase here, so the
// landing page (share.get2.one with no event) can use these without loading it.
import { normalizePairingCode } from './spotPairing';

export const EVENT_PATH_PREFIX = '/e/';
export const HOST_PATH = '/host';

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

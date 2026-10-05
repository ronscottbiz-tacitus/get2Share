import { Timestamp, updateDoc } from 'firebase/firestore';
import { paths } from './events';

/** How long guests get between the host pressing "Group Shot" and every camera firing. */
export const GROUP_SHOT_LEAD_MS = 15_000;
/** The Group Shot screens stay up this long after the cameras fire. */
export const GROUP_SHOT_AFTER_MS = 4_000;

export interface GroupShot {
  id: string;
  firesAt: Timestamp;
  by: string;
}

export const GROUP_SHOT_SUFFIX = ' (Group Shot)';

/** Milliseconds since (positive) or until (negative) the cameras fire, or null if no Group Shot is on. */
export function groupShotClock(gs: GroupShot | null | undefined, now = Date.now()): number | null {
  const at = gs?.firesAt?.toMillis?.();
  if (!at) return null;
  const t = now - at;
  if (t < -GROUP_SHOT_LEAD_MS - 5_000 || t > GROUP_SHOT_AFTER_MS) return null;
  return t;
}

/** Host: start a Group Shot. Every guest who taps "I'm in" fires at the same moment. */
export async function startGroupShot(eventId: string, hostUid: string) {
  const gs: GroupShot = {
    id: `gs_${Date.now().toString(36)}`,
    firesAt: Timestamp.fromMillis(Date.now() + GROUP_SHOT_LEAD_MS),
    by: hostUid,
  };
  await updateDoc(paths.event(eventId), { groupShot: gs });
  return gs;
}

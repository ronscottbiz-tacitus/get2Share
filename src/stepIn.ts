import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';
import { isAdminEmail } from './hosts';
import { Photo } from './types';

// Step In / Step Out: a Pro feature. A host asks for it on one photo; a cloud GPU job
// (services/step-in) turns the photo into two 3D splats and writes photo.stepIn.
//   Step In   the whole scene, with the background behind people filled in
//   Step Out  just the people, as a floating cutout
//
// Pro events have features/{eventId}.pro == true. Only the cloud job (and admins in the
// Firebase console) write that doc; hosts can read it.

/** The cloud job's web address. Override with VITE_STEP_IN_API for a test deployment. */
export const STEP_IN_API: string =
  (import.meta as any).env?.VITE_STEP_IN_API || 'https://ronscottbiz-tacitus--get2share-step-in-api.us-east.modal.run';

export const stepInReady = (p: Pick<Photo, 'stepIn'> | null | undefined) =>
  p?.stepIn?.status === 'ready' && !!p.stepIn.inUrl;

export const stepInBusy = (p: Pick<Photo, 'stepIn'> | null | undefined) =>
  p?.stepIn?.status === 'queued' || p?.stepIn?.status === 'processing';

/** A job that's been working this long without an update has died; offer to start over. */
export const STEP_IN_STUCK_MS = 5 * 60 * 1000;
export const stepInStuck = (p: Pick<Photo, 'stepIn'> | null | undefined, now = Date.now()) => {
  const at = p?.stepIn?.updatedAt?.toMillis?.();
  return stepInBusy(p) && !!at && now - at > STEP_IN_STUCK_MS;
};

/**
 * Can this device make Step In moments for this event? Admins always; other hosts when
 * config/stepIn.allHosts is on (the default, while there's no paid plan) or the event is Pro.
 * The cloud job checks the same things.
 */
export function useCanMakeStepIn(eventId: string, isHost: boolean): boolean {
  const user = auth.currentUser;
  const admin = !!user && !user.isAnonymous && !!user.emailVerified && isAdminEmail(user.email);
  const [allHosts, setAllHosts] = useState(true);
  const [pro, setPro] = useState(false);
  useEffect(() => {
    if (!isHost || admin) return;
    return onSnapshot(
      doc(db, 'config', 'stepIn'),
      (s) => setAllHosts(!s.exists() || s.data()?.allHosts !== false),
      () => setAllHosts(true),
    );
  }, [isHost, admin]);
  useEffect(() => {
    if (!isHost || admin || allHosts) return;
    return onSnapshot(doc(db, 'features', eventId), (s) => setPro(!!s.data()?.pro), () => setPro(false));
  }, [eventId, isHost, admin, allHosts]);
  return isHost && (admin || allHosts || pro);
}

/** Ask the cloud job for a Step In moment. Resolves once it's queued; progress shows up on photo.stepIn. */
export async function requestStepIn(eventId: string, photoId: string, redo = false): Promise<void> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Sign in first.');
  let res: Response;
  try {
    res = await fetch(`${STEP_IN_API}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventId, photoId, redo }),
    });
  } catch {
    throw new Error("Couldn't reach Step In. Check the Wi-Fi and try again.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error((body && typeof body.detail === 'string' && body.detail) || 'Step In is unavailable right now. Try again in a minute.');
  }
}

/** While a Pro host has the app open during a live event, keep a cloud GPU ready, so
 *  "Make Step In" takes seconds instead of a cold start. Pings now and every 4 minutes
 *  (the GPU shuts down 5 minutes after the last one). Silent if anything fails. */
export const STEP_IN_WARM_MS = 4 * 60 * 1000;
const lastWarm = new Map<string, number>();
export function useWarmStepIn(eventId: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const ping = async () => {
      if (document.visibilityState !== 'visible') return;
      // One ping per few minutes per device, however many screens mount this.
      const now = Date.now();
      if (now - (lastWarm.get(eventId) || 0) < STEP_IN_WARM_MS - 30_000) return;
      lastWarm.set(eventId, now);
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) return;
        await fetch(`${STEP_IN_API}/warm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ eventId }),
        });
      } catch { /* warming is best-effort */ }
    };
    ping();
    const t = setInterval(ping, STEP_IN_WARM_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') ping(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [eventId, enabled]);
}

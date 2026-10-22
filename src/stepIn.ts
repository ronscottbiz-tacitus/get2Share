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

/** Can this device make Step In moments for this event? Hosts of Pro events, and admins. */
export function useCanMakeStepIn(eventId: string, isHost: boolean): boolean {
  const user = auth.currentUser;
  const admin = !!user && !user.isAnonymous && !!user.emailVerified && isAdminEmail(user.email);
  const [pro, setPro] = useState(false);
  useEffect(() => {
    if (!isHost || admin) return;
    return onSnapshot(doc(db, 'features', eventId), (s) => setPro(!!s.data()?.pro), () => setPro(false));
  }, [eventId, isHost, admin]);
  return isHost && (admin || pro);
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

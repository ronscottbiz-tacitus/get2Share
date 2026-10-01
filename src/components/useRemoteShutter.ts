import { useCallback, useEffect, useRef, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Photo, GuestSession } from '../types';

/**
 * Tracks each remote "Take photo" from the moment the host taps it until the
 * photo lands, so the Host Console can show what's happening:
 *
 *   sending    → our write is on its way
 *   waiting    → written; waiting for the device to pick it up
 *   capturing  → the device reset trigger_shutter (it heard us) and is shooting/uploading
 *   saved      → a new photo from that device showed up
 *   noresponse → the device never picked it up (asleep, closed, offline)
 *   unconfirmed→ the device heard us, but no photo arrived in time
 *   error      → our write failed
 */
export type ShotPhase =
  | 'sending'
  | 'waiting'
  | 'capturing'
  | 'saved'
  | 'noresponse'
  | 'unconfirmed'
  | 'error';

export interface ShotState {
  phase: ShotPhase;
  phaseAt: number;
  sawTrigger: boolean;
  knownPhotoIds: Set<string>;
  photoUrl?: string;
}

const BUSY: ShotPhase[] = ['sending', 'waiting', 'capturing'];
const NO_RESPONSE_MS = 8000; // device should pick up a trigger within a second or two
const NO_PHOTO_MS = 30000; // countdown + capture + upload (base64 fallback can be slow)
const SHOW_RESULT_MS = 3500; // how long "Saved" / errors stay up before returning to idle

export const isShotBusy = (s?: ShotState) => !!s && BUSY.includes(s.phase);

export function useRemoteShutter(sessions: GuestSession[], photos: Photo[]) {
  const [shots, setShots] = useState<Record<string, ShotState>>({});
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  const setPhase = (id: string, phase: ShotPhase, extra: Partial<ShotState> = {}) =>
    setShots((prev) =>
      prev[id] ? { ...prev, [id]: { ...prev[id], ...extra, phase, phaseAt: Date.now() } } : prev
    );

  const fire = useCallback(async (id: string) => {
    if (isShotBusy(shotsRef.current[id])) return; // no double fires
    const knownPhotoIds = new Set(
      photosRef.current.filter((p) => p.sessionId === id).map((p) => p.id)
    );
    setShots((prev) => ({
      ...prev,
      [id]: { phase: 'sending', phaseAt: Date.now(), sawTrigger: false, knownPhotoIds },
    }));
    try {
      await updateDoc(doc(db, 'sessions', id), {
        trigger_shutter: true,
        last_trigger_at: serverTimestamp(),
      });
      setShots((prev) =>
        prev[id]?.phase === 'sending'
          ? { ...prev, [id]: { ...prev[id], phase: 'waiting', phaseAt: Date.now() } }
          : prev
      );
    } catch (e) {
      console.error('Remote shutter failed:', e);
      setPhase(id, 'error');
    }
  }, []);

  // Device acknowledgment: it flips trigger_shutter back to false when it hears us.
  // Re-check when a shot moves to 'waiting', in case the reset arrived while still 'sending'.
  const waitingKey = (Object.entries(shots) as [string, ShotState][])
    .filter(([, s]) => s.phase === 'waiting')
    .map(([id]) => id)
    .join('|');
  useEffect(() => {
    setShots((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, shot] of Object.entries(prev) as [string, ShotState][]) {
        if (shot.phase !== 'sending' && shot.phase !== 'waiting') continue;
        const session = sessions.find((s) => s.sessionId === id);
        if (!session) {
          next[id] = { ...shot, phase: 'noresponse', phaseAt: Date.now() };
          changed = true;
        } else if ((session as any).trigger_shutter === true && !shot.sawTrigger) {
          next[id] = { ...shot, sawTrigger: true };
          changed = true;
        } else if (
          (session as any).trigger_shutter === false &&
          // Once our write is committed ('waiting'), the cache holds our `true`, so a
          // `false` can only mean the device reset it.
          (shot.sawTrigger || shot.phase === 'waiting')
        ) {
          next[id] = { ...shot, phase: 'capturing', phaseAt: Date.now() };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sessions, waitingKey]);

  // The photo itself: a new photo from that device that wasn't there when we fired.
  useEffect(() => {
    setShots((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [id, shot] of Object.entries(prev) as [string, ShotState][]) {
        if (!BUSY.includes(shot.phase)) continue;
        const fresh = photos.find((p) => p.sessionId === id && !shot.knownPhotoIds.has(p.id));
        if (fresh) {
          next[id] = { ...shot, phase: 'saved', phaseAt: Date.now(), photoUrl: fresh.url };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [photos]);

  // Timeouts, and clearing finished results back to idle.
  const hasShots = Object.keys(shots).length > 0;
  useEffect(() => {
    if (!hasShots) return;
    const tick = setInterval(() => {
      const now = Date.now();
      setShots((prev) => {
        let changed = false;
        const next: Record<string, ShotState> = {};
        for (const [id, shot] of Object.entries(prev) as [string, ShotState][]) {
          const age = now - shot.phaseAt;
          if ((shot.phase === 'sending' || shot.phase === 'waiting') && age > NO_RESPONSE_MS) {
            next[id] = { ...shot, phase: 'noresponse', phaseAt: now };
            changed = true;
          } else if (shot.phase === 'capturing' && age > NO_PHOTO_MS) {
            next[id] = { ...shot, phase: 'unconfirmed', phaseAt: now };
            changed = true;
          } else if (!BUSY.includes(shot.phase) && age > SHOW_RESULT_MS) {
            changed = true; // drop it → back to idle
          } else {
            next[id] = shot;
          }
        }
        return changed ? next : prev;
      });
    }, 500);
    return () => clearInterval(tick);
  }, [hasShots]);

  return { shots, fire };
}

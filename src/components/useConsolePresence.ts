import { useCallback, useEffect, useRef, useState } from 'react';
import { serverTimestamp, setDoc } from 'firebase/firestore';
import { paths } from '../events';
import { FOCUS_AUTO_OFF_MS, HEARTBEAT_MS } from '../liveConsole';

/**
 * Host Console side: tells Share Spots "someone is watching" (so they send
 * previews) and which spot is focused (so that one sends faster).
 * Stops when the console closes or the tab is hidden.
 */
export function useConsolePresence(eventId: string, enabled: boolean) {
  const [focusSpot, setFocusSpotState] = useState<string | null>(null);
  const focusRef = useRef<string | null>(null);
  const ref = paths.console(eventId);

  const write = (watching: boolean) =>
    setDoc(ref, { watching, focusSpot: watching ? focusRef.current : null, heartbeatAt: serverTimestamp() }).catch(
      (e) => console.error('Console presence write failed:', e)
    );

  // Heartbeat while open and visible.
  useEffect(() => {
    if (!enabled) return;
    const beat = () => {
      if (document.visibilityState === 'visible') write(true);
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    const onVis = () => (document.visibilityState === 'visible' ? write(true) : write(false));
    const onHide = () => write(false);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      focusRef.current = null;
      write(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, eventId]);

  // Focus one spot (or none). Auto-releases after a couple of minutes.
  const setFocusSpot = useCallback(
    (id: string | null) => {
      focusRef.current = id;
      setFocusSpotState(id);
      if (enabled) write(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled]
  );

  useEffect(() => {
    if (!focusSpot) return;
    const t = setTimeout(() => setFocusSpot(null), FOCUS_AUTO_OFF_MS);
    return () => clearTimeout(t);
  }, [focusSpot, setFocusSpot]);

  return { focusSpot, setFocusSpot };
}

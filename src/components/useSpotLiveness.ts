import { useEffect, useRef, useState } from 'react';
import { GuestSession } from '../types';
import { OFFLINE_AFTER_MS } from '../liveConsole';

export type Liveness = { state: 'connecting' | 'online' | 'offline'; lastSeenMs: number | null };

/**
 * Host side: tracks when each Share Spot last sent anything, using this
 * device's clock (when the update *arrived*), so a tablet with the wrong time
 * can't look online or offline by mistake.
 */
export function useSpotLiveness(spots: GuestSession[]) {
  const lastSeen = useRef<Record<string, number>>({});
  const lastValue = useRef<Record<string, number>>({});
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  // Record arrivals: lastActive changes every time a spot writes a frame or heartbeat.
  for (const s of spots) {
    const prev = lastValue.current[s.sessionId];
    if (prev === undefined) {
      lastValue.current[s.sessionId] = s.lastActive; // first sighting: don't count it as "now"
    } else if (prev !== s.lastActive) {
      lastValue.current[s.sessionId] = s.lastActive;
      lastSeen.current[s.sessionId] = Date.now();
    }
  }

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);

  return (id: string): Liveness => {
    const seen = lastSeen.current[id] ?? null;
    if (seen && now - seen < OFFLINE_AFTER_MS) return { state: 'online', lastSeenMs: seen };
    if (!seen && now - mountedAt.current < OFFLINE_AFTER_MS) return { state: 'connecting', lastSeenMs: null };
    return { state: 'offline', lastSeenMs: seen };
  };
}

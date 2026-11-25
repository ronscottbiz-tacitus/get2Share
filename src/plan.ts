import { useEffect, useState } from 'react';
import { onSnapshot } from 'firebase/firestore';
import { EventFeatures, paths } from './events';

/** features/{eventId}, live: the event's plan (tier, Flow seconds). null until it loads or if it has none. */
export function useEventFeatures(eventId: string | null | undefined, active = true): EventFeatures | null {
  const [features, setFeatures] = useState<EventFeatures | null>(null);
  useEffect(() => {
    setFeatures(null);
    if (!eventId || !active) return;
    return onSnapshot(
      paths.features(eventId),
      (s) => setFeatures(s.exists() ? (s.data() as EventFeatures) : null),
      () => setFeatures(null),
    );
  }, [eventId, active]);
  return features;
}

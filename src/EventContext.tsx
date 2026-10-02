import { createContext, useContext } from 'react';
import { EventWithId } from './events';

export interface EventContextValue {
  event: EventWithId;
  /** This device can moderate and run the Host Console for this event. */
  isEventHost: boolean;
}

export const EventContext = createContext<EventContextValue | null>(null);

/** The event the current screen belongs to. */
export function useEvent(): EventContextValue {
  const v = useContext(EventContext);
  if (!v) throw new Error('useEvent() used outside an event');
  return v;
}

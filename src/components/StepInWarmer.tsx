import { useEvent } from '../EventContext';
import { eventPhase } from '../events';
import { useStepInShouldWarm, useWarmStepIn } from '../stepIn';

/** Keeps a Step In GPU ready while a Pro host has this event open during the party. */
export default function StepInWarmer() {
  const { event, isEventHost } = useEvent();
  const shouldWarm = useStepInShouldWarm(event.id, isEventHost);
  const phase = eventPhase(event);
  useWarmStepIn(event.id, shouldWarm && (phase === 'live' || phase === 'wrapup'));
  return null;
}

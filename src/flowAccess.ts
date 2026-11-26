// Kept apart from walkthrough.ts so the landing page can link here without loading Firebase.
import { SUPPORT_EMAIL } from './legal';

const FLOW_EMAIL = SUPPORT_EMAIL;

/** Until checkout is built: an email asking for a pass, with what's needed to add it to the event. */
export function passRequestLink(plan: { name: string; usd: number; seconds: number }, eventName: string, eventId: string): string {
  const name = eventName.trim() || 'my event';
  const subject = `${plan.name} for ${name}`;
  const body = `I'd like the ${plan.name} ($${plan.usd}, ${plan.seconds} seconds of Flow) for my event "${name}".\n\nEvent ID: ${eventId}`;
  return `mailto:${FLOW_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export const FLOW_ACCESS_LINK = `mailto:${FLOW_EMAIL}?subject=${encodeURIComponent('Flow early access')}&body=${encodeURIComponent("I'd like to try Flow at my next event.")}`;

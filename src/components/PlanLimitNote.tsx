import React from 'react';
import { Lock } from 'lucide-react';
import { DEVICE_LIMITS, EventTier } from '../events';

/**
 * Shown in place of "Add a Share Spot" / "Add a screen" once an event has as many as its plan
 * allows (DEVICE_LIMITS). Devices already added keep working.
 */
export default function PlanLimitNote({ tier, one, many }: { tier: EventTier; one: string; many: string }) {
  const limit = DEVICE_LIMITS[tier];
  const text =
    tier === 'free'
      ? `Free events get ${limit} ${limit === 1 ? one : many}. Upgrade this event for ${DEVICE_LIMITS.party} (Party) or ${DEVICE_LIMITS.big} (Big Event).`
      : tier === 'party'
        ? `Party events get ${limit} ${many}. Make it a Big Event for ${DEVICE_LIMITS.big}.`
        : `Big Events get ${limit} ${many}. Remove one to add another.`;
  return (
    <div className="w-full min-h-11 px-3.5 py-2.5 rounded-xl border border-dashed border-white/15 text-g2-tertiary text-xs flex items-center gap-2">
      <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

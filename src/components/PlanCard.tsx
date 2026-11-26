import React, { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, Clock, Loader2, Sparkles, Users } from 'lucide-react';
import { ALBUM_LENGTH, DEVICE_LIMITS, EventPhase, EventTier, GUEST_GRACE } from '../events';
import { FlowPlan } from '../walkthrough';
import { passRequestLink } from '../flowAccess';
import { UpgradeOffers } from '../plan';

// The Host Console's plan card and the banners that offer an upgrade at the moment it's needed
// (plans-and-pricing in the Get2Share project). Prices come from the video service (useUpgradeOffers).

const TIER_NAME: Record<EventTier, string> = { free: 'Free', party: 'Party', big: 'Big Event' };

/** What each upgrade adds, in one line. */
function offerLine(p: FlowPlan): string {
  return p.tier === 'party'
    ? `Up to 100 guests, ${DEVICE_LIMITS.party} Share Spots and ${DEVICE_LIMITS.party} TVs, the album kept ${ALBUM_LENGTH.party}`
    : `Unlimited guests, ${DEVICE_LIMITS.big} Share Spots and ${DEVICE_LIMITS.big} TVs, the album kept ${ALBUM_LENGTH.big}, no branding`;
}

const offerTitle = (p: FlowPlan) => (p.stepUp ? `Make it a ${p.name}` : p.name);

/** A button to buy an upgrade: Stripe when checkout is on, otherwise an email asking for it. */
function BuyButton({ p, up, eventName, eventId, label, primary = true }: {
  p: FlowPlan; up: UpgradeOffers; eventName: string; eventId: string; label?: string; primary?: boolean;
}) {
  const cls = `h-9 px-3.5 rounded-lg text-[12px] font-bold inline-flex items-center justify-center gap-1.5 shrink-0 transition-colors ${
    primary ? 'bg-g2-blue hover:bg-g2-blue-hover text-white' : 'border border-white/20 hover:border-white/40 text-white'}`;
  const text = label ?? (p.stepUp ? `Upgrade for $${p.usd} more` : `Upgrade for $${p.usd}`);
  if (!up.checkout) {
    return <a href={passRequestLink(p, eventName, eventId)} className={cls}>Ask for {p.name}</a>;
  }
  return (
    <button type="button" onClick={() => up.buy(p.id)} disabled={!!up.buying} className={`${cls} cursor-pointer disabled:opacity-60 disabled:cursor-wait`}>
      {up.buying === p.id ? <><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />Opening checkout…</> : text}
    </button>
  );
}

export function PlanCard({ tier, guests, guestLimit, up, eventName, eventId, suggested }: {
  tier: EventTier; guests: number; guestLimit: number | null; up: UpgradeOffers; eventName: string; eventId: string;
  /** The host said at creation that the event is this big: point at that upgrade. */
  suggested: 'party' | 'big' | null;
}) {
  // "Not now": the host folds the upgrades away and drops the suggestion; the event stays as it is.
  const [notNow, setNotNow] = useState(false);
  const highlight = !notNow && !!suggested && up.offers.some((p) => p.tier === suggested);
  // The upgrades start folded away (the banner offers one when it's needed), open if the host said how big.
  const [open, setOpen] = useState(false);
  useEffect(() => { if (highlight) setOpen(true); }, [highlight]);
  const fold = () => { setOpen(false); setNotNow(true); };
  const rows: [string, string][] = [
    ['Guests', guestLimit === null ? `${guests}, no limit`
      : guests > guestLimit ? `${guests} (${guestLimit} + ${guests - guestLimit} extra)` : `${guests} of ${guestLimit}`],
    ['Share Spots and TVs', `${DEVICE_LIMITS[tier]} each`],
    ['Album', `${ALBUM_LENGTH[tier]} after the end`],
    ['Get2Share branding', tier === 'big' ? 'Yours to turn off' : 'On'],
  ];
  return (
    <div
      id="plan-card"
      className={`glass-card border rounded-2xl p-5 shadow-lg space-y-4 ${highlight ? 'border-g2-blue/60 ring-1 ring-g2-blue/40' : 'border-white/5'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-g2-blue-light" aria-hidden="true" /> Plan
        </h2>
        <span className={`h-6 px-2.5 inline-flex items-center rounded-full font-mono text-[10px] font-bold tracking-[0.08em] uppercase ${
          tier === 'free' ? 'border border-white/15 text-g2-secondary' : 'bg-g2-blue/20 border border-g2-blue/40 text-g2-blue-light'}`}>
          {TIER_NAME[tier]}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-g2-tertiary">{k}</dt>
            <dd className="text-white text-right">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {highlight && (
        <p className="text-[12px] leading-relaxed text-g2-blue-light">
          You said {suggested === 'big' ? 'more than 100 people' : 'up to 100 people'} are coming: {suggested === 'big' ? 'Big Event' : 'Party'} fits.
          Upgrade now, or any time before guests run out of room.
        </p>
      )}
      {up.offers.length > 0 && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full h-11 px-3.5 rounded-xl border border-white/10 hover:border-white/25 flex items-center justify-between gap-3 text-left cursor-pointer transition-colors"
        >
          <span className="text-[13px] font-bold text-white">{up.offers.some((p) => p.stepUp) ? 'Make it a Big Event' : 'Upgrade this event'}</span>
          <span className="flex items-center gap-1 text-[12px] text-g2-tertiary">
            {up.offers.length === 1 ? `$${up.offers[0].usd}` : `from $${Math.min(...up.offers.map((p) => p.usd))}`}
            <ChevronDown className="w-4 h-4" aria-hidden="true" />
          </span>
        </button>
      )}
      {up.offers.length > 0 && open && (
        <div className="space-y-2">
          {up.offers.map((p) => (
            <div key={p.id} className={`rounded-xl border p-3 flex flex-col gap-2 ${
              highlight && p.tier === suggested ? 'border-g2-blue/60 bg-g2-blue/10' : 'border-white/10'}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-bold text-white">{offerTitle(p)}</span>
                <span className="font-expanded font-black text-[18px] leading-none text-white">${p.usd}</span>
              </div>
              <p className="text-[12px] leading-relaxed text-g2-secondary">{offerLine(p)}, and {p.seconds}{p.stepUp ? ' more' : ''} seconds of Flow.</p>
              <BuyButton p={p} up={up} eventName={eventName} eventId={eventId}
                primary={highlight ? p.tier === suggested : p === up.offers[0]} />
            </div>
          ))}
          {up.error && <p className="text-[12px] text-red-300" aria-live="polite">{up.error}</p>}
          {up.checkoutTest && (
            <p className="text-[11px] leading-relaxed text-amber-200">
              Test mode (only admins see this): pay with card 4242 4242 4242 4242, any future date, any CVC.
            </p>
          )}
          <button
            type="button"
            onClick={fold}
            className="w-full h-10 rounded-lg text-[12px] font-bold text-g2-secondary hover:text-white cursor-pointer transition-colors"
          >
            {tier === 'free' ? 'Not now, stay on Free' : 'Not now'}
          </button>
        </div>
      )}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days before an album closes when the host is offered an upgrade to keep it. */
const ALBUM_WARN_DAYS: Record<EventTier, number> = { free: 3, party: 14, big: 0 };

/**
 * The moment an upgrade is needed: guests nearly or over the limit, or the album about to close.
 * Nothing when all is well.
 */
export function PlanBanner({ tier, guests, guestLimit, phase, closesMs, up, eventName, eventId, now }: {
  tier: EventTier; guests: number; guestLimit: number | null; phase: EventPhase; closesMs: number | null;
  up: UpgradeOffers; eventName: string; eventId: string; now: number;
}) {
  const next = up.offers[0];
  const joining = phase === 'live' || phase === 'wrapup';
  let tone: 'near' | 'over' | 'full' | 'album' | null = null;
  let title = '';
  let detail = '';
  if (joining && guestLimit !== null && guests >= guestLimit - 5) {
    const cap = guestLimit + GUEST_GRACE;
    if (guests >= cap) {
      tone = 'full';
      title = `The event is full: ${guests} guests`;
      detail = 'New guests are waiting on "The host is opening more spots." Upgrade and they get in on their own.';
    } else if (guests > guestLimit) {
      tone = 'over';
      title = `${guests} guests, past the ${guestLimit} included`;
      detail = `${cap - guests} more can join, then new guests wait until you upgrade.`;
    } else {
      tone = 'near';
      title = `${guests} of ${guestLimit} guests`;
      detail = 'Your event is filling up.';
    }
  } else if (phase === 'album' && closesMs !== null && ALBUM_WARN_DAYS[tier] > 0 && closesMs - now <= ALBUM_WARN_DAYS[tier] * DAY_MS) {
    const days = Math.max(1, Math.ceil((closesMs - now) / DAY_MS));
    tone = 'album';
    title = `The album closes ${days === 1 ? 'tomorrow' : `in ${days} days`}`;
    detail = `Then the photos are deleted for everyone. ${next ? `Upgrade to keep it ${ALBUM_LENGTH[next.tier as EventTier]}.` : ''}`;
  }
  if (!tone) return null;
  const cta = next && (tone === 'album'
    ? undefined
    : next.tier === 'party' ? `Upgrade for $${next.usd} to make room for 100` : `${next.stepUp ? `Make it a Big Event for $${next.usd}` : `Big Event for $${next.usd}`}: no guest limit`);
  const warn = tone === 'full' || tone === 'over';
  const Icon = tone === 'album' ? Clock : warn ? AlertTriangle : Users;
  return (
    <div role="status" className={`rounded-2xl border p-4 flex flex-col md:flex-row md:items-center gap-3 ${
      warn ? 'border-amber-400/40 bg-amber-400/[0.07]' : 'border-g2-blue/40 bg-g2-blue/[0.08]'}`}>
      <Icon className={`w-5 h-5 shrink-0 ${warn ? 'text-amber-300' : 'text-g2-blue-light'}`} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-bold text-white">{title}</p>
        <p className="text-[12px] leading-relaxed text-g2-secondary">{detail}</p>
      </div>
      {next && <BuyButton p={next} up={up} eventName={eventName} eventId={eventId} label={cta} />}
      {!next && tone !== 'album' && tier !== 'big' && (
        <span className="text-[12px] text-g2-tertiary">Upgrades are coming soon.</span>
      )}
    </div>
  );
}

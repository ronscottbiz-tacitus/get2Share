import { useCallback, useEffect, useState } from 'react';
import { onSnapshot } from 'firebase/firestore';
import { EventFeatures, paths } from './events';
import { FlowPlan, getFlowMeter, startFlowCheckout } from './walkthrough';

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

/** How many guests joined (events/{eid}/meta/guests), live. */
export function useGuestCount(eventId: string | null | undefined, active = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (!eventId || !active) return;
    return onSnapshot(
      paths.guestCount(eventId),
      (s) => setN(typeof s.data()?.n === 'number' ? (s.data()!.n as number) : 0),
      () => setN(0),
    );
  }, [eventId, active]);
  return n;
}

export interface UpgradeOffers {
  /** Party and Big Event as this event can buy them now (Big Event as the difference on a Party event). */
  offers: FlowPlan[];
  /** Stripe Checkout is on; otherwise a tap emails a request. */
  checkout: boolean;
  checkoutTest: boolean;
  buying: string;
  error: string;
  buy: (planId: string) => Promise<void>;
}

/**
 * The upgrades this event can buy, from the video service (the same list the Flow panel shows).
 * Asks again when the plan changes (tierKey). Empty until upgrades are on sale, except for admins.
 */
export function useUpgradeOffers(eventId: string, active: boolean, tierKey: string): UpgradeOffers {
  const [offers, setOffers] = useState<FlowPlan[]>([]);
  const [checkout, setCheckout] = useState(false);
  const [checkoutTest, setCheckoutTest] = useState(false);
  const [buying, setBuying] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let gone = false;
    getFlowMeter(eventId)
      .then((m) => {
        if (gone) return;
        setOffers((m.plans || []).filter((p) => p.per === 'event' && (p.tier === 'party' || p.tier === 'big')));
        setCheckout(m.checkout === true);
        setCheckoutTest(m.checkoutTest === true);
      })
      .catch(() => { if (!gone) setOffers([]); });
    return () => { gone = true; };
  }, [eventId, active, tierKey]);
  const buy = useCallback(async (planId: string) => {
    setError('');
    setBuying(planId);
    try {
      await startFlowCheckout(eventId, planId); // leaves the page for Stripe
    } catch (e: any) {
      setError(e?.message || "Couldn't open checkout. Try again.");
      setBuying('');
    }
  }, [eventId]);
  return { offers, checkout, checkoutTest, buying, error, buy };
}

/** What the host said at creation ("about how many people?"), kept for their first visit to the console. */
const SUGGEST_KEY = (eventId: string) => `get2share-suggest-plan-${eventId}`;
export function rememberSuggestedPlan(eventId: string, tier: 'party' | 'big') {
  try { sessionStorage.setItem(SUGGEST_KEY(eventId), tier); } catch { /* ignore */ }
}
export function takeSuggestedPlan(eventId: string): 'party' | 'big' | null {
  try {
    const v = sessionStorage.getItem(SUGGEST_KEY(eventId));
    return v === 'party' || v === 'big' ? v : null;
  } catch {
    return null;
  }
}

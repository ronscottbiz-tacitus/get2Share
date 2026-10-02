import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Lock, LogOut, Plus } from 'lucide-react';
import { onSnapshot, query, where } from 'firebase/firestore';
import Get2ShareLockup from './Get2ShareLockup';
import { createEvent, EventWithId, paths } from '../events';

interface HostHomeProps {
  /** Signed in with Google (not an anonymous guest). */
  hasAccount: boolean;
  uid: string;
  email: string | null;
  isAdmin: boolean;
  signInError: string;
  /** Shown when the host followed a link to an event they don't host. */
  notice?: string;
  onSignIn: () => void;
  onSignOut: () => void;
  onOpenEvent: (eventId: string) => void;
  onBack: () => void;
}

/** share.get2.one/host: sign in, see the events you host, create a new one. */
export default function HostHome({
  hasAccount, uid, email, isAdmin, signInError, notice, onSignIn, onSignOut, onOpenEvent, onBack,
}: HostHomeProps) {
  const [events, setEvents] = useState<EventWithId[] | null>(null);
  const [listError, setListError] = useState('');
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [review, setReview] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!hasAccount || !uid) return;
    const q = query(paths.events(), where('hostUids', 'array-contains', uid));
    return onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }) as EventWithId);
        list.sort((a, b) => (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now()));
        setEvents(list);
        if (list.length === 0) setShowForm(true);
      },
      (err) => {
        console.error('Event list failed:', err);
        setListError("Couldn't load your events. If this keeps happening, republish the database rules in Firebase.");
        setEvents([]);
      }
    );
  }, [hasAccount, uid]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('Give your event a name.');
      return;
    }
    setCreating(true);
    setFormError('');
    try {
      const { id } = await createEvent(uid, { name, subtitle, autoApproval: !review });
      onOpenEvent(id);
    } catch (err) {
      console.error('Create event failed:', err);
      setFormError("Couldn't create the event. Check your connection and try again.");
    } finally {
      setCreating(false);
    }
  };

  if (!hasAccount) {
    return (
      <div className="min-h-dvh bg-g2-page text-g2-text font-sans flex items-center justify-center p-5">
        <div className="w-full max-w-sm bg-g2-panel border border-white/[0.08] rounded-2xl p-7 space-y-5 text-center">
          <div className="w-14 h-14 bg-g2-blue/10 border border-g2-blue/30 text-g2-blue-light rounded-xl flex items-center justify-center mx-auto">
            <Lock className="w-7 h-7" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <h1 className="font-expanded font-black text-xl text-white">Host with Get2Share</h1>
            <p className="text-sm text-g2-tertiary leading-relaxed">
              Sign in with Google to create an event, or to open the Host Console for one you run.
            </p>
            {notice && <p className="text-xs text-amber-300">{notice}</p>}
          </div>
          {signInError && <p className="text-xs text-red-400 font-bold" role="alert">{signInError}</p>}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onSignIn}
              className="h-[52px] rounded-lg bg-white text-g2-page font-bold text-[15px] cursor-pointer hover:bg-g2-secondary transition-colors"
            >
              Continue with Google
            </button>
            <button
              type="button"
              onClick={onBack}
              className="h-11 rounded-lg text-g2-secondary hover:text-white text-sm font-semibold cursor-pointer"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-g2-page text-g2-text font-sans px-5 pt-4 pb-10">
      <div className="w-full max-w-xl mx-auto">
        <header className="flex justify-between items-center h-12">
          <button onClick={onBack} aria-label="Back" className="h-11 -ml-2 px-2 flex items-center gap-2 text-g2-secondary hover:text-white cursor-pointer">
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            <Get2ShareLockup className="text-[20px]" />
          </button>
          <button
            onClick={onSignOut}
            className="h-11 px-3 flex items-center gap-1.5 text-xs font-semibold text-g2-tertiary hover:text-white cursor-pointer"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" /> Sign out
          </button>
        </header>

        <p className="mt-6 font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">
          Signed in as {email}{isAdmin ? ' · admin' : ''}
        </p>
        <h1 className="mt-1.5 font-expanded font-black text-[28px] leading-tight text-white">Your events</h1>
        {notice && <p className="mt-2 text-sm text-amber-300">{notice}</p>}
        {listError && <p className="mt-2 text-sm text-red-400" role="alert">{listError}</p>}

        <div className="mt-5 flex flex-col gap-2.5">
          {events === null && <p className="text-sm text-g2-tertiary">Loading…</p>}
          {events?.map((ev) => (
            <button
              key={ev.id}
              onClick={() => onOpenEvent(ev.id)}
              className="w-full text-left bg-g2-panel border border-white/[0.08] hover:border-white/20 rounded-xl px-4 py-3.5 flex items-center justify-between gap-3 cursor-pointer transition-colors"
            >
              <span className="min-w-0">
                <span className="block text-[15px] font-bold text-white truncate">{ev.name}</span>
                <span className="block mt-0.5 font-mono text-[11px] text-g2-tertiary">
                  Code {ev.joinCode} · {ev.status === 'live' ? 'Live' : ev.status}
                  {ev.ownerUid !== uid ? ' · co-host' : ''}
                </span>
              </span>
              <ArrowRight className="w-5 h-5 text-g2-tertiary shrink-0" aria-hidden="true" />
            </button>
          ))}
        </div>

        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className="mt-4 w-full h-[52px] rounded-xl border border-dashed border-g2-blue/50 text-g2-blue-light hover:text-white hover:border-g2-blue hover:bg-g2-blue/10 font-bold text-sm flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <Plus className="w-4 h-4" aria-hidden="true" /> Create an event
          </button>
        ) : (
          <form onSubmit={handleCreate} className="mt-5 bg-g2-panel border border-white/[0.08] rounded-xl p-4 flex flex-col gap-4">
            <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">New event</p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ev-name" className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary">Event name</label>
              <input
                id="ev-name"
                type="text"
                value={name}
                maxLength={80}
                onChange={(e) => { setName(e.target.value); setFormError(''); }}
                placeholder="e.g. Nia's 30th"
                className="h-[52px] px-4 bg-g2-page border border-white/10 focus:border-g2-blue rounded-lg text-white placeholder-g2-muted text-base focus:outline-none"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ev-sub" className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary">Welcome line (optional)</label>
              <input
                id="ev-sub"
                type="text"
                value={subtitle}
                maxLength={200}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder="e.g. Snap away. Tap any photo to react."
                className="h-[52px] px-4 bg-g2-page border border-white/10 focus:border-g2-blue rounded-lg text-white placeholder-g2-muted text-base focus:outline-none"
              />
            </div>
            <label className="min-h-[52px] px-4 rounded-lg bg-g2-page border border-white/10 flex items-center justify-between gap-3 text-sm font-semibold text-white cursor-pointer">
              Review photos before they post
              <input
                type="checkbox"
                checked={review}
                onChange={(e) => setReview(e.target.checked)}
                className="w-5 h-5 accent-[#0052FF]"
              />
            </label>
            <p className="-mt-2 text-xs text-g2-tertiary">
              Anyone with your event's link or code can join. You can make a new link anytime.
            </p>
            {formError && <p className="text-xs text-red-400" role="alert">{formError}</p>}
            <div className="flex gap-2">
              {events && events.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="h-[52px] px-5 rounded-lg border border-white/10 text-g2-secondary hover:text-white font-semibold text-[15px] cursor-pointer"
                >
                  Cancel
                </button>
              )}
              <button
                type="submit"
                disabled={creating}
                className="flex-1 h-[52px] rounded-lg bg-g2-blue hover:bg-g2-blue-hover disabled:opacity-60 text-white font-bold text-[15px] cursor-pointer disabled:cursor-default transition-colors"
              >
                {creating ? 'Creating…' : 'Create event'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

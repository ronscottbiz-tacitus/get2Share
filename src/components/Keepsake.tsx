import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { motion } from 'motion/react';
import { getDoc, onSnapshot, query, where } from 'firebase/firestore';
import { useEvent } from '../EventContext';
import { eventPhase, formatDay, paths } from '../events';
import { Photo } from '../types';
import CloseButton from './CloseButton';
import { useBackToClose } from '../useBackToClose';

interface KeepsakeProps {
  key?: string; // no @types/react here, so JSX needs this spelled out
  sessionId: string;
  nickname: string;
  /** Already linked to a Google account. */
  saved: boolean;
  email: string | null;
  saving: boolean;
  saveError: string;
  onSave: () => void;
  onOpenAccount: () => void;
  onClose: () => void;
}

/** "Your photos from the night": what this phone took, and keeping them for good. */
export default function Keepsake({
  sessionId, nickname, saved, email, saving, saveError, onSave, onOpenAccount, onClose,
}: KeepsakeProps) {
  const { event } = useEvent();
  const [mine, setMine] = useState<Photo[]>([]);

  useEffect(() => {
    return onSnapshot(
      query(paths.photos(event.id), where('sessionId', '==', sessionId)),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }) as Photo).filter((p) => p.status !== 'rejected');
        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setMine(list);
      },
      () => setMine([])
    );
  }, [event.id, sessionId]);

  // Photos taken on a Share Spot that this guest scanned to keep.
  const [kept, setKept] = useState<Photo[]>([]);
  const [keptWaiting, setKeptWaiting] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const unsub = onSnapshot(
      paths.member(event.id, sessionId),
      async (snap) => {
        const ids: string[] = ((snap.data() as any)?.kept || []).slice(-300);
        const results = await Promise.all(
          ids.map((id) =>
            getDoc(paths.photo(event.id, id))
              .then((d) => (d.exists() ? ({ id: d.id, ...(d.data() as any) } as Photo) : null))
              .catch(() => undefined) // not approved yet, so not visible to guests
          )
        );
        if (cancelled) return;
        setKept(results.filter((p): p is Photo => !!p && p.status === 'approved'));
        setKeptWaiting(results.filter((p) => p === undefined || (p && p.status === 'pending')).length);
      },
      () => { setKept([]); setKeptWaiting(0); }
    );
    return () => { cancelled = true; unsub(); };
  }, [event.id, sessionId]);

  const phase = eventPhase(event);
  const albumUntil = event.expireAt?.toMillis?.() ?? null;
  const day = event.endsAt ? formatDay(event.endsAt.toMillis()) : null;
  const all = [...mine, ...kept.filter((k) => !mine.some((m) => m.id === k.id))].sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );
  const shown = all.slice(0, 9);
  useBackToClose(true, onClose);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-g2-page/80 flex items-end justify-center font-sans"
      onClick={onClose}
    >
      <motion.section
        role="dialog"
        aria-modal="true"
        aria-labelledby="keepsake-title"
        initial={{ y: 40 }}
        animate={{ y: 0 }}
        exit={{ y: 40 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[92dvh] overflow-y-auto bg-g2-panel border-t border-white/10 rounded-t-[20px] px-5 pt-3 pb-8 flex flex-col gap-4"
      >
        <div className="flex items-center justify-between">
          <div className="w-10 h-1 rounded-full bg-white/15 mx-auto" />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">
              {event.name}{day ? ` · ${day}` : ''}
            </p>
            <h2 id="keepsake-title" className="mt-1 font-expanded font-black text-[26px] leading-tight text-white">
              {all.length === 0
                ? 'Your photos'
                : kept.length === 0
                  ? `You took ${mine.length} ${mine.length === 1 ? 'photo' : 'photos'}.`
                  : `${all.length} ${all.length === 1 ? 'photo' : 'photos'} from tonight.`}
            </h2>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {all.length > 0 ? (
          <div className="grid grid-cols-3 gap-1.5">
            {shown.map((p, i) => (
              <div key={p.id} className="relative aspect-square rounded-lg overflow-hidden bg-black/40">
                <img src={p.url} alt="" loading="lazy" className="w-full h-full object-cover" />
                {i === shown.length - 1 && all.length > shown.length && (
                  <span className="absolute inset-0 bg-g2-page/70 flex items-center justify-center font-expanded font-black text-lg text-white">
                    +{all.length - shown.length}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-g2-tertiary leading-relaxed">
            Photos you take show up here. Saving keeps everything you've added to {event.name} with you.
          </p>
        )}

        {keptWaiting > 0 && (
          <p className="text-xs text-g2-tertiary">
            {keptWaiting === 1 ? '1 Share Spot photo is' : `${keptWaiting} Share Spot photos are`} waiting for the host to approve {keptWaiting === 1 ? 'it' : 'them'}.
          </p>
        )}

        {saved ? (
          <div className="p-4 rounded-xl bg-emerald-400/10 border border-emerald-400/30 flex flex-col gap-3">
            <p className="flex items-start gap-2.5 text-sm text-white">
              <Check className="w-5 h-5 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>
                Saved to <span className="font-bold">{email}</span>. Sign in with that account on any device to see your events and photos.
              </span>
            </p>
            <button
              onClick={onOpenAccount}
              className="h-11 rounded-lg border border-white/15 text-white font-semibold text-sm cursor-pointer hover:bg-white/5"
            >
              See your events
            </button>
          </div>
        ) : (
          <div className="p-4 rounded-xl bg-g2-page border border-white/10 flex flex-col gap-3">
            <div>
              <p className="text-[15px] font-bold text-white">Keep them for good</p>
              <p className="mt-1 text-[13px] leading-relaxed text-g2-tertiary">
                {phase === 'album' && albumUntil
                  ? `This album closes ${formatDay(albumUntil)}. `
                  : albumUntil
                    ? `The album stays open until ${formatDay(albumUntil)}. `
                    : ''}
                Save your photos to keep them on any device. No new password, no app.
              </p>
            </div>
            <button
              onClick={onSave}
              disabled={saving}
              className="h-[52px] rounded-lg bg-white hover:bg-g2-secondary disabled:opacity-60 text-g2-page font-bold text-[15px] cursor-pointer disabled:cursor-default transition-colors"
            >
              {saving ? 'Saving…' : 'Continue with Google'}
            </button>
            {saveError && <p className="text-xs text-red-400" role="alert">{saveError}</p>}
            <p className="text-xs text-g2-muted leading-relaxed">
              You stay “{nickname}” to everyone at the party. We never post anything for you.
            </p>
          </div>
        )}
      </motion.section>
    </motion.div>
  );
}

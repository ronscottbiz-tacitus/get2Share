import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, LayoutDashboard, ShieldCheck, Users, X } from 'lucide-react';
import { onSnapshot, query, updateDoc, where } from 'firebase/firestore';
import { useEvent } from '../EventContext';
import { eventPhase, paths } from '../events';
import { groupShotClock, startGroupShot } from '../groupShot';
import { Photo } from '../types';
import CloseButton from './CloseButton';
import { useBackToClose } from '../useBackToClose';

const SHOT_SUFFIX = /\s*\((Tripod|Photo Spot|Share Spot|Guest Lens|Group Shot)\)$/;

/** Approve or decline photos one after another, without leaving the party. */
function ApproveSheet({ pending, onClose }: { key?: string; pending: Photo[]; onClose: () => void }) {
  const { event } = useEvent();
  const [busy, setBusy] = useState<string | null>(null);
  useBackToClose(true, onClose);
  const decide = async (p: Photo, status: 'approved' | 'rejected') => {
    setBusy(p.id);
    try {
      await updateDoc(paths.photo(event.id, p.id), { status });
    } catch (err) {
      console.error('Review failed:', err);
    }
    setBusy(null);
  };
  const approveAll = async () => {
    setBusy('all');
    await Promise.all(pending.map((p) => updateDoc(paths.photo(event.id, p.id), { status: 'approved' }).catch(() => {})));
    setBusy(null);
  };
  const current = pending[0];
  useEffect(() => { if (pending.length === 0) onClose(); }, [pending.length]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black flex flex-col font-sans"
      role="dialog"
      aria-modal="true"
      aria-label="Photos to approve"
    >
      <div className="flex items-center justify-between p-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <div>
          <p className="font-mono text-[10.5px] font-bold tracking-[0.1em] uppercase text-g2-tertiary">To approve</p>
          <p className="font-expanded font-black text-xl text-white">{pending.length} {pending.length === 1 ? 'photo' : 'photos'}</p>
        </div>
        <div className="flex items-center gap-2">
          {pending.length > 1 && (
            <button
              type="button"
              onClick={approveAll}
              disabled={busy !== null}
              className="h-10 px-3.5 rounded-lg border border-white/15 text-white text-[13px] font-bold cursor-pointer disabled:opacity-50"
            >
              Approve all
            </button>
          )}
          <CloseButton onClick={onClose} />
        </div>
      </div>
      {current && (
        <>
          <div className="flex-1 min-h-0 px-4 flex items-center justify-center">
            <img key={current.id} src={current.url} alt={`From ${current.nickname}`} className="max-w-full max-h-full object-contain rounded-xl" />
          </div>
          <p className="px-5 pt-3 text-center text-sm text-g2-secondary">
            From <span className="font-bold text-white">@{current.nickname.replace(SHOT_SUFFIX, '')}</span>
          </p>
          <div className="grid grid-cols-2 gap-3 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={() => decide(current, 'rejected')}
              disabled={busy !== null}
              className="h-14 rounded-xl border border-white/15 text-white font-bold text-[15px] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <X className="w-5 h-5" aria-hidden="true" /> Decline
            </button>
            <button
              type="button"
              onClick={() => decide(current, 'approved')}
              disabled={busy !== null}
              className="h-14 rounded-xl bg-white text-g2-page font-bold text-[15px] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Check className="w-5 h-5" aria-hidden="true" /> Approve
            </button>
          </div>
        </>
      )}
    </motion.div>
  );
}

/**
 * Only hosts see this: the few things a host does mid-party, one tap away.
 * Everything else stays in the Host Console.
 */
export default function HostBar({ hostUid, onOpenConsole }: { hostUid: string; onOpenConsole: () => void }) {
  const { event } = useEvent();
  const [pending, setPending] = useState<Photo[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  const phase = eventPhase(event, now);
  const live = phase === 'live' || phase === 'wrapup';
  const clock = groupShotClock(event.groupShot ?? null, now);
  const counting = clock !== null && clock < 0;

  useEffect(() => {
    return onSnapshot(
      query(paths.photos(event.id), where('status', '==', 'pending')),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }) as Photo);
        list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        setPending(list);
      },
      () => setPending([])
    );
  }, [event.id]);

  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [counting, event.groupShot?.id]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  // Notice a Group Shot as soon as it starts.
  useEffect(() => { setNow(Date.now()); }, [event.groupShot?.id]);

  const groupShot = async () => {
    setError('');
    let spots = true;
    try { spots = localStorage.getItem('get2share-gs-spots') !== '0'; } catch { /* default on */ }
    try {
      await startGroupShot(event.id, hostUid, spots);
      setNow(Date.now());
    } catch (err) {
      console.error('Group Shot failed to start:', err);
      setError("Group Shot didn't start.");
    }
  };

  const btn = 'h-10 rounded-lg text-[12.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors';

  return (
    <>
      <div className="max-w-3xl mx-auto px-3 pt-2.5 pb-1 grid grid-cols-3 gap-2" role="toolbar" aria-label="Host tools">
        <button
          type="button"
          onClick={() => setReviewing(true)}
          disabled={pending.length === 0}
          className={`${btn} ${pending.length ? 'bg-amber-400 text-g2-page' : 'border border-white/10 text-g2-tertiary cursor-default'}`}
        >
          <ShieldCheck className="w-4 h-4" aria-hidden="true" />
          {pending.length ? `${pending.length} to approve` : 'All approved'}
        </button>
        <button
          type="button"
          onClick={groupShot}
          disabled={!live || counting}
          className={`${btn} bg-g2-blue hover:bg-g2-blue-hover text-white disabled:opacity-60 disabled:cursor-default`}
        >
          <Users className="w-4 h-4" aria-hidden="true" />
          {counting ? `In ${Math.ceil(-clock! / 1000)}…` : 'Group Shot'}
        </button>
        <button type="button" onClick={onOpenConsole} className={`${btn} border border-white/15 text-white hover:bg-white/5`}>
          <LayoutDashboard className="w-4 h-4" aria-hidden="true" /> Console
        </button>
      </div>
      {error && <p className="text-center text-[11px] text-red-400" role="alert">{error}</p>}
      <AnimatePresence>
        {reviewing && pending.length > 0 && <ApproveSheet key="approve" pending={pending} onClose={() => setReviewing(false)} />}
      </AnimatePresence>
    </>
  );
}

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { onSnapshot, query, where } from 'firebase/firestore';
import { useEvent } from '../EventContext';
import { eventPhase, paths } from '../events';
import { GROUP_SHOT_SUFFIX, groupShotClock, startGroupShot } from '../groupShot';

/** Host: one press, and every guest who taps "I'm in" fires their camera at the same moment. */
export default function GroupShotButton({ hostUid }: { hostUid: string }) {
  const { event } = useEvent();
  const gs = event.groupShot ?? null;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [landed, setLanded] = useState(0);
  // Include Share Spots? Remembered on this device.
  const [spots, setSpots] = useState(() => {
    try { return localStorage.getItem('get2share-gs-spots') !== '0'; } catch { return true; }
  });
  const toggleSpots = (v: boolean) => {
    setSpots(v);
    try { localStorage.setItem('get2share-gs-spots', v ? '1' : '0'); } catch { /* ignore */ }
  };
  const phase = eventPhase(event, now);
  const clock = groupShotClock(gs, now);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Count the Group Shot photos as they land (the last minute and a half of photos is plenty).
  const firesAt = gs?.firesAt?.toMillis?.() ?? 0;
  useEffect(() => {
    if (!firesAt) return;
    setLanded(0);
    return onSnapshot(
      query(paths.photos(event.id), where('createdAt', '>=', firesAt - 60_000)),
      (snap) => setLanded(snap.docs.filter((d) => String((d.data() as any).nickname || '').endsWith(GROUP_SHOT_SUFFIX)).length),
      () => setLanded(0)
    );
  }, [event.id, firesAt]);

  if (phase !== 'live' && phase !== 'wrapup') return null;

  const counting = clock !== null && clock < 0;
  const justFired = firesAt > 0 && now >= firesAt && now < firesAt + 90_000;

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await startGroupShot(event.id, hostUid, spots);
    } catch (err) {
      console.error('Group Shot failed to start:', err);
      setError("Couldn't start it. Publish the latest database rules, then try again.");
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={go}
        disabled={busy || counting}
        className="bg-g2-blue hover:bg-g2-blue-hover disabled:opacity-80 text-white font-bold px-4 py-2.5 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer disabled:cursor-default transition-all duration-300"
      >
        <Users className="w-4 h-4" aria-hidden="true" />
        {counting ? `Group Shot in ${Math.ceil(-clock! / 1000)}…` : 'Group Shot'}
      </button>
      <label className="flex items-center gap-1.5 text-[11px] text-g2-secondary cursor-pointer select-none">
        <input
          type="checkbox"
          checked={spots}
          disabled={counting}
          onChange={(e) => toggleSpots(e.target.checked)}
          className="w-3.5 h-3.5 accent-[#0052FF] cursor-pointer"
        />
        Include Share Spots
      </label>
      {(counting || justFired) && (
        <span className="text-[11px] text-g2-tertiary" role="status">
          {counting ? 'Guests are getting their cameras up.' : `${landed} ${landed === 1 ? 'photo' : 'photos'} from the Group Shot`}
        </span>
      )}
      {error && <span className="text-[11px] text-red-400" role="alert">{error}</span>}
    </div>
  );
}

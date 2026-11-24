import { useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, Download, Loader2, Play, Share2 } from 'lucide-react';
import { canShareFiles, downloadBlob, shareFiles } from '../savePhotos';
import { useBackToClose } from '../useBackToClose';
import { FLOW_ACCESS_LINK, Walkthrough, WALKTHROUGH_LABEL, walkthroughFile } from '../walkthrough';
import CloseButton from './CloseButton';

/** The label that always goes next to a Walkthrough video. */
export function WalkthroughLabel({ className = '' }: { className?: string }) {
  return <p className={`text-[12px] leading-snug text-g2-secondary ${className}`}>{WALKTHROUGH_LABEL}</p>;
}

/** The video itself. Silent, so controls never need to ask for sound. */
export function WalkthroughVideo({ w, className = '', onPlay }: { w: Walkthrough; className?: string; onPlay?: () => void }) {
  return (
    <video
      key={w.videoUrl || ''}
      src={w.videoUrl || undefined}
      poster={w.posterUrl || undefined}
      controls
      playsInline
      muted
      preload="metadata"
      onPlay={onPlay}
      aria-label={`Walkthrough video. ${WALKTHROUGH_LABEL}`}
      className={`bg-black rounded-xl ${w.aspect === '9:16' ? 'aspect-[9/16]' : 'aspect-video'} ${className}`}
    />
  );
}

/** The gallery's card for an approved video. */
export function WalkthroughCard({ w, onOpen }: { key?: string; w: Walkthrough; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full mb-3 flex items-center gap-3 p-2.5 text-left rounded-xl border border-g2-blue/40 bg-g2-panel hover:border-g2-blue cursor-pointer transition-colors"
    >
      <span className="relative w-20 h-20 shrink-0 rounded-lg overflow-hidden bg-black">
        {w.posterUrl && <img src={w.posterUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />}
        <span className="absolute inset-0 flex items-center justify-center bg-black/25">
          <span className="w-9 h-9 rounded-full bg-g2-blue flex items-center justify-center">
            <Play className="w-4 h-4 fill-white text-white ml-0.5" aria-hidden="true" />
          </span>
        </span>
      </span>
      <span className="min-w-0">
        <span className="block font-expanded font-black text-[15px] leading-tight text-white">Flow video</span>
        <WalkthroughLabel className="mt-1" />
      </span>
    </button>
  );
}

/**
 * Full screen for guests and hosts: the video, its label, saving it and sharing it. A phone only
 * opens the share sheet straight from a tap, so the file has to be in hand before the tap. It's
 * too big to fetch for everyone who just looks, so it's fetched once someone presses play (or on
 * their first tap, if they go straight for a button). The Flow already ends with the Get2Share
 * card on free events, so the shared copy is the video as it is.
 */
export default function WalkthroughPlayer({ w, eventName, canSave, onClose }: {
  key?: string;
  w: Walkthrough;
  eventName: string;
  canSave: boolean;
  onClose: () => void;
}) {
  useBackToClose(true, onClose);
  const [file, setFile] = useState<File | null>(null);
  const [getting, setGetting] = useState(false);
  const [done, setDone] = useState<'' | 'saved' | 'shared'>('');
  const [note, setNote] = useState('');
  const fetching = useRef<Promise<File | null> | null>(null);
  // Phones can hand a video to other apps; most laptop browsers can't, so they only get Save (a download).
  const [phone] = useState(() => {
    try { return canShareFiles([new File([''], 'flow.mp4', { type: 'video/mp4' })]); } catch { return false; }
  });

  const prepare = () => {
    if (!canSave) return Promise.resolve(null);
    if (!fetching.current) {
      setGetting(true);
      fetching.current = walkthroughFile(eventName, w)
        .then((f) => { setFile(f); return f; })
        .catch(() => { fetching.current = null; return null; })
        .finally(() => setGetting(false));
    }
    return fetching.current;
  };

  const handOver = async (f: File, how: 'saved' | 'shared') => {
    if (!canShareFiles([f])) {
      downloadBlob(f, f.name);
      setDone('saved');
      return;
    }
    try {
      if (await shareFiles([f])) setDone(how);
    } catch {
      setNote(how === 'shared' ? "Your phone didn't open sharing. Tap Share again." : "Your phone didn't open the save sheet. Tap Save again.");
    }
  };

  const act = async (how: 'saved' | 'shared') => {
    setNote('');
    if (file) return handOver(file, how);
    const f = await prepare();
    if (!f) {
      window.open(w.videoUrl!, '_blank', 'noopener'); // CORS not set, or a bad connection: press and hold there
      return;
    }
    if (!canShareFiles([f])) return handOver(f, how); // laptops can download right away
    setNote(how === 'shared' ? 'Ready. Tap Share again.' : 'Ready. Tap Save, then choose Save Video.');
  };

  const icon = (Icon: typeof Download, mine: boolean) =>
    getting && !file ? <Loader2 className="w-[18px] h-[18px] animate-spin" aria-hidden="true" />
      : mine ? <Check className="w-[18px] h-[18px]" aria-hidden="true" />
      : <Icon className="w-[18px] h-[18px]" aria-hidden="true" />;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label="Flow video"
      className="fixed inset-0 z-[60] bg-g2-page flex flex-col font-sans"
    >
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 relative">
        <CloseButton onClick={onClose} className="absolute top-4 right-4 z-10 bg-black/60 hover:bg-black/80" />
        <WalkthroughVideo w={w} className="max-w-full max-h-full" onPlay={() => { prepare(); }} />
      </div>
      <div className="px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] border-t border-white/[0.08] bg-g2-panel flex flex-col gap-3 items-center">
        <WalkthroughLabel className="text-center text-[13px]" />
        <a href={FLOW_ACCESS_LINK} className="block text-center text-[13px] font-bold text-g2-blue-light hover:text-white underline underline-offset-2">
          Make one for your next event
        </a>
        {canSave && (
          <div className="w-full max-w-sm flex gap-2">
            <button
              type="button"
              onClick={() => act('saved')}
              disabled={getting && !file}
              className="flex-1 h-12 rounded-xl border border-white/15 bg-white/5 hover:border-white/30 disabled:opacity-60 text-white font-bold text-[14px] flex items-center justify-center gap-2 cursor-pointer disabled:cursor-wait transition-colors"
            >
              {icon(Download, done === 'saved')}
              {done === 'saved' ? 'Saved' : phone ? 'Save' : 'Save to this device'}
            </button>
            {phone && (
              <button
                type="button"
                onClick={() => act('shared')}
                disabled={getting && !file}
                className="flex-1 h-12 rounded-xl bg-g2-blue hover:bg-g2-blue-hover disabled:opacity-60 text-white font-bold text-[14px] flex items-center justify-center gap-2 cursor-pointer disabled:cursor-wait transition-colors"
              >
                {icon(Share2, done === 'shared')}
                {done === 'shared' ? 'Shared' : 'Share'}
              </button>
            )}
          </div>
        )}
        {(note || (getting && !file)) && (
          <p className="text-[12px] text-g2-secondary" aria-live="polite">{note || 'Getting the video ready…'}</p>
        )}
      </div>
    </motion.div>
  );
}

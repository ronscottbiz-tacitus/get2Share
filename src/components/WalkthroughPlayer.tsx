import { useState } from 'react';
import { motion } from 'motion/react';
import { Check, Download, Loader2, Play } from 'lucide-react';
import { canShareFiles, downloadBlob, shareFiles } from '../savePhotos';
import { useBackToClose } from '../useBackToClose';
import { Walkthrough, WALKTHROUGH_LABEL, walkthroughFile } from '../walkthrough';
import CloseButton from './CloseButton';

/** The label that always goes next to a Walkthrough video. */
export function WalkthroughLabel({ className = '' }: { className?: string }) {
  return <p className={`text-[12px] leading-snug text-g2-secondary ${className}`}>{WALKTHROUGH_LABEL}</p>;
}

/** The video itself. Silent, so controls never need to ask for sound. */
export function WalkthroughVideo({ w, className = '' }: { w: Walkthrough; className?: string }) {
  return (
    <video
      key={w.videoUrl || ''}
      src={w.videoUrl || undefined}
      poster={w.posterUrl || undefined}
      controls
      playsInline
      muted
      preload="metadata"
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
        <span className="block font-expanded font-black text-[15px] leading-tight text-white">Walkthrough video</span>
        <WalkthroughLabel className="mt-1" />
      </span>
    </button>
  );
}

/**
 * Full screen for guests and hosts: the video, its label, and saving it. On a phone the file is
 * fetched on the first tap and handed over on the second, since the share sheet has to open
 * straight from a tap and this file is too big to fetch every time someone just watches.
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
  const [state, setState] = useState<'idle' | 'getting' | 'saved'>('idle');
  const [note, setNote] = useState('');

  const handOver = async (f: File) => {
    if (canShareFiles([f])) {
      try {
        if (await shareFiles([f])) setState('saved');
      } catch {
        setNote("Your phone didn't open the save sheet. Tap Save again.");
      }
    } else {
      downloadBlob(f, f.name);
      setState('saved');
    }
  };

  const save = async () => {
    setNote('');
    if (file) return handOver(file);
    setState('getting');
    try {
      const f = await walkthroughFile(eventName, w);
      setFile(f);
      setState('idle');
      if (!canShareFiles([f])) await handOver(f); // laptops can download right away
      else setNote('Ready. Tap Save, then choose Save Video.');
    } catch {
      setState('idle');
      window.open(w.videoUrl!, '_blank', 'noopener'); // CORS not set, or a bad connection: press and hold there
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      aria-label="Walkthrough video"
      className="fixed inset-0 z-[60] bg-g2-page flex flex-col font-sans"
    >
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 relative">
        <CloseButton onClick={onClose} className="absolute top-4 right-4 z-10 bg-black/60 hover:bg-black/80" />
        <WalkthroughVideo w={w} className="max-w-full max-h-full" />
      </div>
      <div className="px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] border-t border-white/[0.08] bg-g2-panel flex flex-col gap-3 items-center">
        <WalkthroughLabel className="text-center text-[13px]" />
        {canSave && (
          <button
            type="button"
            onClick={save}
            disabled={state === 'getting'}
            className="w-full max-w-sm h-12 rounded-xl border border-white/15 bg-white/5 hover:border-white/30 disabled:opacity-60 text-white font-bold text-[14px] flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            {state === 'getting' ? <Loader2 className="w-[18px] h-[18px] animate-spin" aria-hidden="true" />
              : state === 'saved' ? <Check className="w-[18px] h-[18px]" aria-hidden="true" />
              : <Download className="w-[18px] h-[18px]" aria-hidden="true" />}
            {state === 'getting' ? 'Getting it ready…' : state === 'saved' ? 'Saved' : 'Save to this device'}
          </button>
        )}
        {note && <p className="text-[12px] text-g2-secondary" aria-live="polite">{note}</p>}
      </div>
    </motion.div>
  );
}

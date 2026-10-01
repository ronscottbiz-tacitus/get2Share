import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, Camera, Check, Loader2 } from 'lucide-react';
import { ShotState, isShotBusy } from './useRemoteShutter';

const LABELS: Record<string, string> = {
  idle: 'Take photo',
  sending: 'Sending…',
  waiting: 'Sending…',
  capturing: 'Taking photo…',
  saved: 'Saved',
  noresponse: 'Try again',
  unconfirmed: 'Take another',
  error: 'Try again',
};

/** One-line status under/next to the button, in plain language. */
export function shotStatusText(shot?: ShotState, idle = 'Ready') {
  switch (shot?.phase) {
    case 'sending':
    case 'waiting':
      return 'Reaching the camera…';
    case 'capturing':
      return 'Shutter fired';
    case 'saved':
      return 'In the gallery';
    case 'noresponse':
      return "Camera didn't respond";
    case 'unconfirmed':
      return 'Fired · photo still uploading';
    case 'error':
      return "Couldn't send. Check your connection";
    default:
      return idle;
  }
}

interface ShutterButtonProps {
  shot?: ShotState;
  onFire: () => void;
  variant?: 'blue' | 'white';
  size?: 'sm' | 'md';
  label?: string;
  disabled?: boolean;
}

export function ShutterButton({ shot, onFire, variant = 'blue', size = 'sm', label, disabled = false }: ShutterButtonProps) {
  const phase = shot?.phase ?? 'idle';
  const busy = isShotBusy(shot);
  const failed = phase === 'noresponse' || phase === 'error';

  const tone = disabled && !busy
    ? 'bg-white/5 text-g2-muted border border-white/10'
    : phase === 'saved'
      ? 'bg-emerald-500 text-white'
      : failed
        ? 'bg-amber-400 text-g2-page hover:bg-amber-300'
        : busy
          ? variant === 'white'
            ? 'bg-white/70 text-g2-page'
            : 'bg-g2-blue/70 text-white'
          : variant === 'white'
            ? 'bg-white hover:bg-g2-secondary text-g2-page'
            : 'bg-g2-blue hover:bg-g2-blue-hover text-white shadow-md shadow-g2-blue/20';

  const sizing = size === 'md' ? 'text-xs py-2.5 px-5 rounded-xl min-w-[150px]' : 'text-xs px-3 py-1.5 rounded-xl min-w-[124px]';

  const Icon =
    phase === 'saved' ? Check : failed ? AlertCircle : busy ? Loader2 : Camera;

  return (
    <motion.button
      type="button"
      onClick={onFire}
      disabled={busy || disabled}
      aria-busy={busy}
      aria-live="polite"
      whileTap={busy || disabled ? undefined : { scale: 0.92 }}
      animate={phase === 'capturing' ? { opacity: [1, 0.6, 1] } : { opacity: 1 }}
      transition={phase === 'capturing' ? { duration: 0.9, repeat: Infinity } : { duration: 0.15 }}
      className={`${tone} ${sizing} font-extrabold flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-default transition-colors duration-200`}
    >
      <Icon className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
      {phase === 'idle' && label ? label : LABELS[phase]}
    </motion.button>
  );
}

/** White flash when the device fires, plus the new photo popping in when it lands. */
export function ShotOverlay({ shot }: { shot?: ShotState }) {
  return (
    <>
      <AnimatePresence>
        {shot?.phase === 'capturing' && (
          <motion.div
            key={`flash-${shot.phaseAt}`}
            initial={{ opacity: 0.9 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className="absolute inset-0 bg-white pointer-events-none"
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {shot?.phase === 'saved' && shot.photoUrl && (
          <motion.div
            key={`saved-${shot.phaseAt}`}
            initial={{ opacity: 0, scale: 0.6, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 380, damping: 26 }}
            className="absolute bottom-2 right-2 w-[34%] max-w-[120px] rounded-lg overflow-hidden border-2 border-white shadow-xl shadow-black/60 pointer-events-none"
          >
            <img src={shot.photoUrl} alt="Photo just taken" className="w-full aspect-[4/3] object-cover" />
            <span className="absolute bottom-0 inset-x-0 bg-emerald-500 text-white text-[9px] font-black uppercase tracking-wider text-center py-0.5 flex items-center justify-center gap-1">
              <Check className="w-2.5 h-2.5" aria-hidden="true" /> Saved
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

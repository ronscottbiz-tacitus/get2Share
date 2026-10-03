import React, { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Hand } from 'lucide-react';
import { useQr } from '../useQr';

export type SpotPhase = 'idle' | 'countdown' | 'saving' | 'captured' | 'failed';

interface SpotTapLayerProps {
  phase: SpotPhase;
  count: number;
  spotName: string;
  /** Link that joins the event (shown small while idle). */
  joinUrl: string | null;
  /** Link that joins the event and keeps the photo just taken. */
  keepUrl: string | null;
  photoUrl: string | null;
  /** Seconds left before the captured screen goes back to idle. */
  secondsLeft: number;
}

const CONFETTI_COLORS = ['#0052FF', '#6C93FF', '#FFFFFF', '#34D399', '#FBBF24'];

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.35,
        duration: 1.6 + Math.random() * 1.2,
        rotate: (Math.random() - 0.5) * 720,
        drift: (Math.random() - 0.5) * 160,
        w: 6 + Math.random() * 8,
        h: 10 + Math.random() * 10,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      })),
    []
  );
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {pieces.map((p) => (
        <motion.span
          key={p.id}
          className="absolute top-0 rounded-[2px]"
          style={{ left: `${p.left}%`, width: p.w, height: p.h, background: p.color }}
          initial={{ y: -40, x: 0, rotate: 0, opacity: 1 }}
          animate={{ y: '110vh', x: p.drift, rotate: p.rotate, opacity: [1, 1, 0.8] }}
          transition={{ duration: p.duration, delay: p.delay, ease: 'easeIn' }}
        />
      ))}
    </div>
  );
}

/**
 * What guests see on a Share Spot: "Tap anywhere for a photo", a 5-second
 * countdown, a flash, then the photo with a code to keep it.
 * Taps are handled by the parent; this layer only draws.
 */
export default function SpotTapLayer({ phase, count, spotName, joinUrl, keepUrl, photoUrl, secondsLeft }: SpotTapLayerProps) {
  const joinQr = useQr(phase === 'idle' ? joinUrl : null, 240);
  const keepQr = useQr(keepUrl, 420);

  return (
    <>
      {/* Idle: the invitation */}
      <AnimatePresence>
        {phase === 'idle' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-x-0 bottom-0 z-10 pointer-events-none bg-gradient-to-t from-black/90 via-black/55 to-transparent pt-24 pb-[max(1.5rem,env(safe-area-inset-bottom))] px-6 flex items-end justify-between gap-6"
          >
            <div className="min-w-0">
              <motion.div
                animate={{ scale: [1, 1.04, 1] }}
                transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
                className="inline-flex items-center gap-3 h-16 px-6 rounded-full bg-g2-blue text-white shadow-[0_0_48px_rgba(0,82,255,0.55)]"
              >
                <Hand className="w-7 h-7" aria-hidden="true" />
                <span className="font-expanded font-black text-[clamp(20px,3.4vmin,34px)] leading-none">Tap anywhere for a photo</span>
              </motion.div>
              <p className="mt-3 text-[clamp(14px,2vmin,20px)] text-white/85 font-semibold">
                5-second countdown. Everyone in it can keep a copy.
              </p>
              <p className="mt-1 font-mono text-[11px] tracking-[0.1em] uppercase text-white/55">Share Spot · {spotName}</p>
            </div>
            {joinQr && (
              <div className="shrink-0 hidden min-[600px]:flex flex-col items-center gap-1.5">
                <img src={joinQr} alt="Scan to join the event" className="w-[clamp(84px,13vmin,128px)] h-auto rounded-lg bg-white p-1.5" />
                <span className="font-mono text-[10px] tracking-[0.1em] uppercase text-white/70">Scan to join</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Countdown */}
      <AnimatePresence>
        {phase === 'countdown' && (
          <motion.div
            key="countdown"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-20 pointer-events-none flex flex-col items-center justify-center gap-4"
            aria-live="assertive"
          >
            <p className="font-condensed font-extrabold text-[clamp(16px,2.6vmin,26px)] tracking-[0.18em] uppercase text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
              Everybody in!
            </p>
            <AnimatePresence mode="popLayout">
              <motion.div
                key={count}
                initial={{ scale: 1.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={{ duration: 0.35 }}
                className="w-[clamp(160px,34vmin,320px)] h-[clamp(160px,34vmin,320px)] rounded-full border-[6px] border-white bg-black/45 flex items-center justify-center"
              >
                <span className="font-expanded font-black text-[clamp(96px,22vmin,220px)] leading-none text-white">{count}</span>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Flash + saving */}
      {phase === 'saving' && (
        <motion.div
          initial={{ opacity: 1 }}
          animate={{ opacity: 0.92 }}
          transition={{ duration: 0.6 }}
          className="absolute inset-0 z-30 bg-white flex items-center justify-center pointer-events-none"
        >
          <p className="font-expanded font-black text-[clamp(28px,6vmin,56px)] text-g2-page">Got it!</p>
        </motion.div>
      )}

      {/* Captured: the photo and a code to keep it */}
      <AnimatePresence>
        {phase === 'captured' && (
          <motion.div
            key="captured"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 bg-g2-page flex flex-col landscape:flex-row items-center justify-center gap-[4vmin] p-[5vmin] pointer-events-none"
          >
            <Confetti />
            {photoUrl && (
              <motion.img
                src={photoUrl}
                alt="The photo you just took"
                initial={{ scale: 0.9, rotate: -2 }}
                animate={{ scale: 1, rotate: -2 }}
                className="relative z-10 max-h-[48vh] landscape:max-h-[78vh] max-w-full landscape:max-w-[55vw] object-contain rounded-xl border-[6px] border-white shadow-2xl"
              />
            )}
            <div className="relative flex flex-col items-center text-center gap-3 z-10">
              <p className="font-expanded font-black text-[clamp(26px,5vmin,52px)] leading-tight text-white">
                Scan to keep <span className="text-g2-blue-light">this one.</span>
              </p>
              {keepQr && (
                <img src={keepQr} alt="Scan to keep this photo" className="w-[clamp(150px,30vmin,300px)] h-auto rounded-xl bg-white p-2" />
              )}
              <p className="text-[clamp(13px,2vmin,18px)] text-white/75 font-semibold">Everyone in the photo can scan it.</p>
              <p className="font-mono text-[11px] tracking-[0.1em] uppercase text-white/50">Tap for another · back to the camera in {secondsLeft}s</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {phase === 'failed' && (
        <div className="absolute inset-0 z-30 bg-g2-page/90 flex flex-col items-center justify-center gap-3 text-center p-8 pointer-events-none">
          <p className="font-expanded font-black text-[clamp(24px,4.5vmin,44px)] text-white">That one didn't save.</p>
          <p className="text-[clamp(14px,2.2vmin,20px)] text-white/75">Check the Wi-Fi, then tap to try again.</p>
        </div>
      )}
    </>
  );
}

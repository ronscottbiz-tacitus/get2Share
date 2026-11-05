import React, { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import CloseButton from './CloseButton';
import FlickBird from './FlickBird';
import VideoBird from './VideoBird';
import { useBackToClose } from '../useBackToClose';
import { useMediaReady } from '../deferredMedia';
import { FLOW_ACCESS_LINK } from '../walkthrough';

// Both loops are AI samples, so their badges and players say so. Flow was made with the real tool from
// AI-generated photos; Flick is an AI scene with the real borrowed-camera screen placed on G2's phone.
type FeatureId = 'flick' | 'flow';
const FEATURES: Record<FeatureId, {
  name: string; card: string; poster: string; full: string; fullPoster: string; blurb: string; note: string; early?: boolean;
}> = {
  flick: {
    name: 'Flick',
    card: '/media/flick-card-v2.mp4',
    poster: '/media/flick-poster-v2.webp',
    full: '/media/flick-full.mp4',
    fullPoster: '/media/flick-full-poster.webp',
    blurb: 'Your friend holds the camera. You see the view and tap the shutter from your phone, and everyone gets the flick.',
    note: 'AI-generated sample to show the idea. Not real guests.',
  },
  flow: {
    name: 'Flow',
    card: '/media/flow-night-card.mp4',
    poster: '/media/flow-night-poster.webp',
    full: '/media/flow-night.mp4',
    fullPoster: '/media/flow-night-full-poster.webp',
    blurb: 'Your photos become one moving video. AI fills in the moments between, and you approve it before anyone sees it.',
    note: 'Made with Flow from AI-generated photos. Not real guests.',
    early: true,
  },
};

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function Badge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 h-[22px] whitespace-nowrap px-2 rounded-full bg-black/60 border border-white/20 font-mono text-[9px] font-bold tracking-[0.08em] uppercase text-white backdrop-blur ${className}`}>
      {children}
    </span>
  );
}

const AiBadge = ({ className = '' }: { className?: string }) => (
  <Badge className={className}><Sparkles className="w-3 h-3" aria-hidden="true" /> AI sample</Badge>
);

/**
 * One card's muted video. The cards take turns: this one plays through once while it's its turn and on
 * screen, then hands over, holding its last frame. A video that can't play hands over too.
 */
function CardVideo({ id, still, active, held, onDone }: { id: FeatureId; still: boolean; active: boolean; held: boolean; onDone: () => void }) {
  const { card, poster } = FEATURES[id];
  const ref = useRef<HTMLVideoElement | null>(null);
  const mediaReady = useMediaReady();
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v || still || !mediaReady || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.35 });
    io.observe(v);
    return () => io.disconnect();
  }, [still, mediaReady]);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (active && onScreen && !held) {
      if (!v.src) v.src = card;
      if (v.ended) v.currentTime = 0;
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [active, onScreen, held, card]);
  if (still) return <img src={poster} alt="" className="absolute inset-0 w-full h-full object-cover" />;
  return (
    <video
      ref={ref}
      poster={poster}
      muted
      playsInline
      preload="none"
      aria-hidden="true"
      onEnded={onDone}
      onError={onDone}
      className="absolute inset-0 w-full h-full object-cover"
    />
  );
}

function FeaturePlayer({ id, onClose }: { id: FeatureId; onClose: () => void }) {
  const f = FEATURES[id];
  useBackToClose(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col font-sans" role="dialog" aria-modal="true" aria-label={f.name}>
      {/* The words sit under the video, so they never cover it or a label burned into it. */}
      <div className="relative flex-1 min-h-0">
        <video src={f.full} poster={f.fullPoster} autoPlay muted loop playsInline className="absolute inset-0 w-full h-full object-contain" />
        <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <AiBadge />
          <CloseButton onClick={onClose} className="bg-black/60 hover:bg-black/80" />
        </div>
      </div>
      <div className="shrink-0 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {f.early && <p className="font-mono text-[10px] font-bold tracking-[0.12em] uppercase text-g2-blue-light">Early access</p>}
        <p className="mt-0.5 font-expanded font-black text-xl text-white">{f.name}</p>
        <p className="mt-1 text-[13px] leading-snug text-white/80 max-w-sm">{f.blurb}</p>
        <p className="mt-1.5 text-[11px] text-white/55">{f.note}</p>
      </div>
    </div>
  );
}

/** Landing: the two things that make Get2Share what it is. */
export default function HeroFeatures() {
  const [still] = useState(prefersReducedMotion);
  const [open, setOpen] = useState<FeatureId | null>(null);
  const [turn, setTurn] = useState<FeatureId>('flick');
  const video = (id: FeatureId) => (
    <CardVideo
      id={id}
      still={still}
      active={turn === id}
      held={open !== null}
      onDone={() => setTurn((t) => (t === id ? (id === 'flick' ? 'flow' : 'flick') : t))}
    />
  );
  return (
    <section className="mt-5" aria-labelledby="hero-features-title">
      <h2 id="hero-features-title" className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary">
        Flick it. Flash it. Flow it.
      </h2>
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <article className="rounded-xl overflow-hidden bg-g2-panel border border-white/[0.08] hover:border-g2-blue/60 transition-colors flex flex-col">
          <button type="button" onClick={() => setOpen('flick')} className="text-left cursor-pointer flex flex-col flex-1">
            <span className="relative block w-full aspect-[4/5] bg-black">
              {video('flick')}
              <AiBadge className="absolute bottom-2 left-2" />
            </span>
            <span className="block p-3">
              <span className="flex items-center gap-1.5">
                <FlickBird flying className="w-[30px] h-[24px] shrink-0" />
                <span className="font-expanded font-black text-[17px] leading-tight text-white">Flick</span>
              </span>
              <span className="block mt-1.5 text-[13px] font-bold leading-snug text-white">Get in the shot.</span>
              <span className="block mt-1 text-[12.5px] leading-snug text-g2-secondary">{FEATURES.flick.blurb}</span>
              <span className="sr-only"> Play the AI-generated sample.</span>
            </span>
          </button>
        </article>

        <article className="rounded-xl overflow-hidden bg-g2-panel border border-white/[0.08] hover:border-g2-blue/60 transition-colors flex flex-col">
          <button type="button" onClick={() => setOpen('flow')} className="text-left cursor-pointer flex flex-col flex-1">
            <span className="relative block w-full aspect-[4/5] bg-black">
              {video('flow')}
              <AiBadge className="absolute bottom-2 left-2" />
            </span>
            <span className="block p-3">
              <span className="flex items-center gap-1.5">
                <VideoBird flying className="w-[30px] h-[22px] shrink-0" />
                <span className="font-expanded font-black text-[17px] leading-tight text-white">Flow</span>
              </span>
              <span className="mt-1.5 inline-block font-mono text-[9px] font-bold tracking-[0.08em] uppercase text-g2-blue-light">Early access</span>
              <span className="block mt-1.5 text-[13px] font-bold leading-snug text-white">Walk back through the night.</span>
              <span className="block mt-1 text-[12.5px] leading-snug text-g2-secondary">{FEATURES.flow.blurb}</span>
              <span className="sr-only"> Play the AI-generated sample.</span>
            </span>
          </button>
          <a href={FLOW_ACCESS_LINK} className="block px-3 pb-3 text-[12.5px] font-bold text-g2-blue-light hover:text-white underline underline-offset-2">
            Ask for early access
          </a>
        </article>
      </div>
      {open && <FeaturePlayer id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

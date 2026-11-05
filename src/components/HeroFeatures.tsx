import React, { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import CloseButton from './CloseButton';
import FlickBird from './FlickBird';
import VideoBird from './VideoBird';
import { useBackToClose } from '../useBackToClose';
import { useMediaReady } from '../deferredMedia';

// The Flow loop is the old AI concept clip, not something the app made, so its badge and player say
// so. The Flick loop is an AI scene followed by the real app's borrowed-camera countdown.
const FLOW = {
  card: '/media/pro-swim-card.mp4',
  full: '/media/pro-swim.mp4',
  poster: '/media/pro-swim-poster.webp',
};
const FLICK = { card: '/media/flick-card.mp4', poster: '/media/flick-poster.webp' };

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

/** A muted loop that only loads and plays while it's on screen. */
function CardLoop({ card, poster, still }: { card: string; poster: string; still: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const mediaReady = useMediaReady();
  useEffect(() => {
    const v = ref.current;
    if (!v || still || !mediaReady || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!v.src) v.src = card;
          v.play().catch(() => {});
        } else {
          v.pause();
        }
      },
      { threshold: 0.35 }
    );
    io.observe(v);
    return () => io.disconnect();
  }, [card, still, mediaReady]);
  if (still) return <img src={poster} alt="" className="absolute inset-0 w-full h-full object-cover" />;
  return (
    <video ref={ref} poster={poster} muted loop playsInline preload="none" aria-hidden="true" className="absolute inset-0 w-full h-full object-cover" />
  );
}

function FlowPlayer({ onClose }: { onClose: () => void }) {
  useBackToClose(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col font-sans" role="dialog" aria-modal="true" aria-label="Flow">
      <video src={FLOW.full} poster={FLOW.poster} autoPlay muted loop playsInline className="absolute inset-0 w-full h-full object-contain" />
      <div className="relative flex items-center justify-between p-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <AiBadge />
        <CloseButton onClick={onClose} className="bg-black/60 hover:bg-black/80" />
      </div>
      <div className="relative mt-auto px-5 pt-16 pb-[max(1.5rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/90 via-black/50 to-transparent">
        <p className="font-mono text-[10px] font-bold tracking-[0.12em] uppercase text-g2-blue-light">Early access</p>
        <p className="mt-1 font-expanded font-black text-2xl text-white">Flow</p>
        <p className="mt-1 text-sm text-white/80 max-w-sm">Your party photos become one moving video. You approve it before guests see it.</p>
        <p className="mt-2 text-[11px] text-white/55">AI-generated sample to show the idea. Not real guests.</p>
      </div>
    </div>
  );
}

/** Landing: the two things that make Get2Share what it is. */
export default function HeroFeatures() {
  const [still] = useState(prefersReducedMotion);
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-5" aria-labelledby="hero-features-title">
      <h2 id="hero-features-title" className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary">
        Why Get2Share
      </h2>
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <article className="rounded-xl overflow-hidden bg-g2-panel border border-white/[0.08] flex flex-col">
          <div className="relative aspect-[4/5] bg-black">
            <CardLoop card={FLICK.card} poster={FLICK.poster} still={still} />
            <AiBadge className="absolute bottom-2 left-2" />
          </div>
          <div className="p-3">
            <h3 className="flex items-center gap-1.5 font-expanded font-black text-[17px] leading-tight text-white">
              <FlickBird flying className="w-[30px] h-[24px] shrink-0" /> Flick
            </h3>
            <p className="mt-1 text-[12.5px] leading-snug text-g2-secondary">
              You're always in the group photo you never get. Borrow a guest's camera, snap the flick, and it lands in everyone's album.
            </p>
          </div>
        </article>

        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-xl overflow-hidden bg-g2-panel border border-white/[0.08] hover:border-g2-blue/60 text-left cursor-pointer transition-colors flex flex-col"
        >
          <span className="relative block w-full aspect-[4/5] bg-black">
            <CardLoop card={FLOW.card} poster={FLOW.poster} still={still} />
            <AiBadge className="absolute bottom-2 left-2" />
          </span>
          <span className="block p-3">
            <span className="flex items-center gap-1.5">
              <VideoBird flying className="w-[30px] h-[22px] shrink-0" />
              <span className="font-expanded font-black text-[17px] leading-tight text-white">Flow</span>
            </span>
            <span className="mt-1.5 inline-block font-mono text-[9px] font-bold tracking-[0.08em] uppercase text-g2-blue-light">Early access</span>
            <span className="block mt-1 text-[12.5px] leading-snug text-g2-secondary">
              Your party photos become one moving video. You approve it before guests see it.
            </span>
            <span className="sr-only"> Play the AI-generated sample.</span>
          </span>
        </button>
      </div>
      {open && <FlowPlayer onClose={() => setOpen(false)} />}
    </section>
  );
}

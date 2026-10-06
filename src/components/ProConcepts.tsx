import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import CloseButton from './CloseButton';
import { useBackToClose } from '../useBackToClose';

interface Concept {
  id: string;
  title: string;
  blurb: string;
  card: string;
  full: string;
  poster: string;
}

const CONCEPTS: Concept[] = [
  {
    id: 'matrix',
    title: 'The Matrix shot',
    blurb: 'Every phone fires at once. Freeze the moment and fly around it.',
    card: '/media/pro-matrix-card.mp4',
    full: '/media/pro-matrix.mp4',
    poster: '/media/pro-matrix-poster.jpg',
  },
  {
    id: 'swim',
    title: 'Swim through the party',
    blurb: 'Glide through the crowd, stitched from everyone’s photos.',
    card: '/media/pro-swim-card.mp4',
    full: '/media/pro-swim.mp4',
    poster: '/media/pro-swim-poster.jpg',
  },
];

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function ConceptLabel({ className = '', short = false }: { className?: string; short?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 h-[22px] whitespace-nowrap px-2 rounded-full bg-black/60 border border-white/20 font-mono text-[9px] font-bold tracking-[0.08em] uppercase text-white backdrop-blur ${className}`}>
      <Sparkles className="w-3 h-3" aria-hidden="true" /> {short ? 'AI concept' : 'AI-generated concept'}
    </span>
  );
}

/** A muted loop that only loads and plays while it's on screen. */
function CardVideo({ c, still }: { c: Concept; still: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || still || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!v.src) v.src = c.card;
          v.play().catch(() => {});
        } else {
          v.pause();
        }
      },
      { threshold: 0.35 }
    );
    io.observe(v);
    return () => io.disconnect();
  }, [c.card, still]);
  if (still) return <img src={c.poster} alt="" className="absolute inset-0 w-full h-full object-cover" />;
  return (
    <video
      ref={ref}
      poster={c.poster}
      muted
      loop
      playsInline
      preload="none"
      aria-hidden="true"
      className="absolute inset-0 w-full h-full object-cover"
    />
  );
}

function Player({ c, onClose }: { c: Concept; onClose: () => void }) {
  useBackToClose(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col font-sans" role="dialog" aria-modal="true" aria-label={c.title}>
      <video src={c.full} poster={c.poster} autoPlay muted loop playsInline className="absolute inset-0 w-full h-full object-contain" />
      <div className="relative flex items-center justify-between p-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <ConceptLabel />
        <CloseButton onClick={onClose} className="bg-black/60 hover:bg-black/80" />
      </div>
      <div className="relative mt-auto px-5 pt-16 pb-[max(1.5rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/90 via-black/50 to-transparent">
        <p className="font-mono text-[10px] font-bold tracking-[0.12em] uppercase text-g2-blue-light">Coming to Pro</p>
        <p className="mt-1 font-expanded font-black text-2xl text-white">{c.title}</p>
        <p className="mt-1 text-sm text-white/80 max-w-sm">{c.blurb}</p>
        <p className="mt-2 text-[11px] text-white/55">Made with AI to show the idea. Not real guests, and not something the app makes yet.</p>
      </div>
    </div>
  );
}

/** Landing: what Pro will add, shown as AI-generated concept clips. */
export default function ProConcepts() {
  const [still] = useState(prefersReducedMotion);
  const [open, setOpen] = useState<Concept | null>(null);
  return (
    <section className="mt-5" aria-labelledby="pro-concepts-title">
      <div className="flex items-baseline justify-between">
        <h2 id="pro-concepts-title" className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary">
          Coming to Pro
        </h2>
        <span className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-g2-muted">AI-generated concepts</span>
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        {CONCEPTS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setOpen(c)}
            aria-label={`${c.title}: play the AI-generated concept`}
            className="relative aspect-[9/14] rounded-xl overflow-hidden bg-g2-panel border border-white/[0.08] hover:border-g2-blue/60 text-left cursor-pointer transition-colors"
          >
            <CardVideo c={c} still={still} />
            <span className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
            <ConceptLabel short className="absolute top-2 left-2" />
            <span className="absolute inset-x-0 bottom-0 p-3">
              <span className="block font-expanded font-black text-[15px] leading-tight text-white">{c.title}</span>
              <span className="block mt-1 text-[11.5px] leading-snug text-white/75 max-[359px]:hidden">{c.blurb}</span>
            </span>
          </button>
        ))}
      </div>
      {open && <Player c={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

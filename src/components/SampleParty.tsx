import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Camera, ChevronLeft, ChevronRight, Monitor, Sparkles } from 'lucide-react';
import Get2ShareLockup from './Get2ShareLockup';
import CloseButton from './CloseButton';
import { useBackToClose } from '../useBackToClose';
import { SAMPLE_EVENT, SAMPLE_PHOTOS, SamplePhoto, sampleTime } from '../sample';

interface SamplePartyProps {
  onHost: () => void;
  onBack: () => void;
}

const NEWEST_FIRST = [...SAMPLE_PHOTOS].reverse();
const GUEST_COUNT = new Set(SAMPLE_PHOTOS.filter((p) => p.kind === 'guest').map((p) => p.by)).size;
const SPOT_COUNT = new Set(SAMPLE_PHOTOS.filter((p) => p.kind === 'spot').map((p) => p.by)).size;

function AiBadge({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full border border-amber-300/40 bg-amber-300/10 text-amber-200 font-mono text-[10px] font-bold tracking-[0.08em] uppercase ${className}`}>
      <Sparkles className="w-3 h-3" aria-hidden="true" /> AI-generated sample
    </span>
  );
}

function Credit({ p }: { p: SamplePhoto }) {
  return <span className="truncate">{p.by}</span>;
}

/** Full-screen photo viewer for the sample: swipe back or the X closes it. */
function Viewer({ list, index, onIndex, onClose }: { list: SamplePhoto[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  useBackToClose(true, onClose);
  const p = list[index];
  const go = (d: number) => onIndex((index + d + list.length) % list.length);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col font-sans" role="dialog" aria-modal="true" aria-label={p.alt}>
      <div className="flex items-center justify-between px-4 pt-4">
        <AiBadge />
        <CloseButton onClick={onClose} className="bg-black/60 hover:bg-black/80" />
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center px-2 py-3 relative">
        <img src={p.src} alt={p.alt} className="max-w-full max-h-full object-contain rounded-xl" />
        <button type="button" onClick={() => go(-1)} aria-label="Previous photo" className="absolute left-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/50 border border-white/20 text-white flex items-center justify-center cursor-pointer">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <button type="button" onClick={() => go(1)} aria-label="Next photo" className="absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/50 border border-white/20 text-white flex items-center justify-center cursor-pointer">
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>
      <div className="px-5 pb-6 flex items-center justify-between text-sm">
        <div>
          <p className="font-bold text-white">{p.kind === 'spot' ? `Share Spot · ${p.by.replace('Spot · ', '')}` : p.kind === 'group' ? p.by : `Posted by ${p.by}`}</p>
          <p className="text-xs text-g2-tertiary">{sampleTime(p.minute)} · {p.alt}</p>
        </div>
        <span className="font-mono text-[11px] text-g2-muted">{index + 1}/{list.length}</span>
      </div>
    </div>
  );
}

/** The sample's TV: a photo wall with a "Just in" takeover every few seconds, like a live party. */
function SampleTv({ onClose }: { onClose: () => void }) {
  useBackToClose(true, onClose);
  // Pretend photos keep arriving: walk through the party from the start.
  const [arrived, setArrived] = useState(12);
  const [justIn, setJustIn] = useState<SamplePhoto | null>(null);
  useEffect(() => {
    let n = 12;
    let hide: ReturnType<typeof setTimeout> | undefined;
    const t = setInterval(() => {
      n = n >= SAMPLE_PHOTOS.length ? 12 : n + 1;
      setArrived(n);
      setJustIn(SAMPLE_PHOTOS[n - 1]);
      hide = setTimeout(() => setJustIn(null), 3500);
    }, 7000);
    return () => { clearInterval(t); clearTimeout(hide); };
  }, []);
  const wall = SAMPLE_PHOTOS.slice(0, arrived).reverse().slice(0, 9);

  return (
    <div className="fixed inset-0 z-50 bg-g2-page text-white font-sans flex flex-col p-[3vmin] gap-[2vmin]" role="dialog" aria-modal="true" aria-label="Sample party on the TV">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Get2ShareLockup className="text-[clamp(14px,2.4vmin,24px)]" />
          <p className="mt-1 font-expanded font-black text-[clamp(18px,3.6vmin,40px)] leading-tight truncate">{SAMPLE_EVENT.name}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <AiBadge className="hidden sm:inline-flex" />
          <CloseButton onClick={onClose} label="Close TV view" />
        </div>
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-3 grid-rows-[repeat(3,minmax(0,1fr))] gap-[1.2vmin]">
        {wall.map((p, i) => (
          <motion.div
            key={p.id}
            layout
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`relative overflow-hidden rounded-[1.2vmin] bg-g2-panel ${i === 0 ? 'col-span-2 row-span-2' : ''}`}
          >
            <img src={p.src} alt={p.alt} className="absolute inset-0 w-full h-full object-cover object-[50%_25%]" />
            <span className="absolute left-0 bottom-0 m-[0.8vmin] px-[1vmin] py-[0.4vmin] rounded-md bg-black/60 font-mono text-[clamp(9px,1.4vmin,14px)]">{p.by}</span>
          </motion.div>
        ))}
      </div>
      <p className="text-center font-mono text-[clamp(9px,1.5vmin,14px)] tracking-[0.1em] uppercase text-white/50">A new photo lands every few seconds · share.get2.one</p>

      <AnimatePresence>
        {justIn && (
          <motion.div
            key={justIn.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-[2vmin] p-[4vmin]"
          >
            <span className="px-4 h-9 inline-flex items-center rounded-full bg-emerald-400 text-g2-page font-mono text-sm font-bold tracking-[0.12em] uppercase">Just in</span>
            <motion.img
              src={justIn.src}
              alt={justIn.alt}
              initial={{ scale: 0.85 }}
              animate={{ scale: 1 }}
              className="max-h-[70vh] max-w-full object-contain rounded-2xl border-[0.6vmin] border-white shadow-2xl"
            />
            <p className="font-bold text-[clamp(14px,2.4vmin,26px)]">{justIn.by}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** share.get2.one/sample — a read-only party anyone can browse. Every photo is AI-generated. */
export default function SampleParty({ onHost, onBack }: SamplePartyProps) {
  const [tab, setTab] = useState<'all' | 'spots'>('all');
  const [open, setOpen] = useState<number | null>(null);
  const [tv, setTv] = useState(false);
  const shown = useMemo(
    () => NEWEST_FIRST.filter((p) => tab === 'all' || p.kind !== 'guest'),
    [tab]
  );

  return (
    <div className="min-h-dvh bg-g2-page text-g2-text font-sans pb-28">
      <header className="max-w-3xl mx-auto px-5 pt-4 flex items-center justify-between h-16">
        <button type="button" onClick={onBack} aria-label="Back" className="w-11 h-11 -ml-2 rounded-full flex items-center justify-center text-g2-secondary hover:text-white hover:bg-white/5 cursor-pointer">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <Get2ShareLockup className="text-[20px]" />
        <span className="w-11" />
      </header>

      <section className="max-w-3xl mx-auto px-5 mt-2">
        <AiBadge />
        <h1 className="mt-3 font-expanded font-black text-[30px] leading-[1.05] text-white">{SAMPLE_EVENT.name}</h1>
        <p className="mt-1 text-sm text-g2-secondary">{SAMPLE_EVENT.subtitle} · from {SAMPLE_EVENT.startsAt}</p>
        <p className="mt-3 text-[13px] leading-relaxed text-g2-tertiary">
          A pretend party to show how Get2Share works. Everyone here, guests and G2 alike, was made with AI. This is what your gallery looks like when everyone's phone, the Share Spots and the Group Shot all post to one place.
        </p>
        <dl className="mt-4 grid grid-cols-3 gap-2">
          {[
            [String(SAMPLE_PHOTOS.length), 'photos'],
            [String(GUEST_COUNT), 'guests posting'],
            [String(SPOT_COUNT), 'Share Spots'],
          ].map(([n, label]) => (
            <div key={label} className="rounded-xl bg-g2-panel border border-white/[0.08] px-3 py-2.5">
              <dt className="sr-only">{label}</dt>
              <dd className="font-expanded font-black text-xl text-white">{n}</dd>
              <dd className="text-[11px] text-g2-tertiary">{label}</dd>
            </div>
          ))}
        </dl>
      </section>

      <nav className="max-w-3xl mx-auto px-5 mt-5 mb-3 flex gap-2 overflow-x-auto" aria-label="Filter photos">
        {([['all', 'All photos'], ['spots', 'Share Spots & Group Shot']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={`shrink-0 whitespace-nowrap h-10 px-[18px] rounded-full text-[13px] cursor-pointer transition-colors ${tab === id ? 'bg-g2-text text-g2-page font-bold' : 'border border-white/10 text-g2-secondary hover:text-white font-semibold'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="max-w-3xl mx-auto px-5">
        <div className="columns-2 sm:columns-3 gap-2 space-y-2">
          {shown.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setOpen(i)}
              aria-label={`${p.alt}, by ${p.by}`}
              className="block w-full break-inside-avoid bg-g2-panel rounded-[10px] border border-white/[0.08] overflow-hidden relative cursor-pointer text-left"
            >
              <img src={p.src} alt="" loading="lazy" width={p.w} height={p.h} className="w-full h-auto object-cover max-h-72" />
              <span className="absolute inset-x-0 bottom-0 h-8 px-2.5 flex items-center justify-between bg-g2-page/80 font-mono text-[10px] text-g2-secondary">
                <Credit p={p} />
                <span className="shrink-0 text-g2-muted">{sampleTime(p.minute)}</span>
              </span>
              {p.kind !== 'guest' && (
                <span className={`absolute top-2 left-2 h-[22px] px-2 inline-flex items-center rounded-full bg-g2-page/80 font-mono text-[9.5px] font-bold tracking-[0.06em] uppercase ${p.kind === 'spot' ? 'border border-g2-blue-light text-g2-blue-light' : 'border border-white text-white'}`}>
                  {p.kind === 'spot' ? 'Share Spot' : 'Group Shot'}
                </span>
              )}
            </button>
          ))}
        </div>
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 bg-g2-page/95 border-t border-white/[0.08] backdrop-blur">
        <div className="max-w-3xl mx-auto px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setTv(true)}
            className="h-[52px] rounded-lg border border-white/15 hover:border-white/30 text-white font-bold text-[14px] flex items-center justify-center gap-2 cursor-pointer"
          >
            <Monitor className="w-[18px] h-[18px]" aria-hidden="true" /> See it on the TV
          </button>
          <button
            type="button"
            onClick={onHost}
            className="h-[52px] rounded-lg bg-g2-blue hover:bg-g2-blue-hover text-white font-bold text-[14px] flex items-center justify-center gap-2 cursor-pointer"
          >
            <Camera className="w-[18px] h-[18px]" aria-hidden="true" /> Host your own
          </button>
        </div>
      </div>

      {open !== null && <Viewer list={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
      {tv && <SampleTv onClose={() => setTv(false)} />}
    </div>
  );
}

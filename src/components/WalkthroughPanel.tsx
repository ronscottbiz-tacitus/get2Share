import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, Loader2, Monitor, RefreshCw, Smartphone, Trash2,
  Clapperboard,
} from 'lucide-react';
import { useEvent } from '../EventContext';
import { Photo } from '../types';
import { useBackToClose } from '../useBackToClose';
import {
  approveWalkthrough, canMakeWalkthrough, clipsDone, createWalkthrough, deleteWalkthrough, FlowMeter, flowSeconds, getFlowMeter,
  redoWalkthroughClip, setFlowLabel, unpublishWalkthrough, useHostWalkthroughs, useWalkthroughConfig, Walkthrough, WalkthroughAspect, walkthroughBusy,
  WalkthroughConfig, WALKTHROUGH_NOTICE, walkthroughSlow,
} from '../walkthrough';
import CloseButton from './CloseButton';
import VideoBird from './VideoBird';
import { WalkthroughLabel, WalkthroughVideo } from './WalkthroughPlayer';

const primary = 'h-12 rounded-xl bg-g2-blue hover:bg-g2-blue-hover disabled:opacity-40 disabled:hover:bg-g2-blue text-white font-bold text-[14px] flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed transition-colors';
const secondary = 'h-11 rounded-xl border border-white/15 bg-white/5 hover:border-white/30 disabled:opacity-40 text-white font-bold text-[13px] flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed transition-colors';
const danger = 'h-11 rounded-xl border border-red-400/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40 font-bold text-[13px] flex items-center justify-center gap-1.5 cursor-pointer transition-colors';

/** Host Console: make a Flow video, follow it, preview it, approve it, take it down. */
export default function WalkthroughPanel({ photos }: { photos: Photo[] }) {
  const { event, isEventHost } = useEvent();
  const config = useWalkthroughConfig(isEventHost);
  const rows = useHostWalkthroughs(event.id, isEventHost);
  const [studioOpen, setStudioOpen] = useState(false);
  const [meter, setMeter] = useState<FlowMeter | null>(null);
  // An invited host's access comes from the cloud job, since the invite list is private.
  const canMake = canMakeWalkthrough(config, isEventHost) || (isEventHost && config.enabled && meter?.access === true);
  const stamp = `${rows[0]?.id ?? ''}:${rows[0]?.status ?? ''}:${rows[0]?.redosUsed ?? 0}`;
  useEffect(() => {
    if (!isEventHost || !config.enabled) return;
    let on = true;
    getFlowMeter(event.id).then((m) => { if (on) setMeter(m); }).catch(() => { if (on) setMeter(null); });
    return () => { on = false; };
  }, [event.id, isEventHost, config.enabled, stamp]);

  // A host can always manage a video they have, even with the feature off.
  if (!canMake && rows.length === 0) return null;
  const current = rows[0] ?? null;
  // A refused or failed video doesn't use up the event's video, so the host can start over.
  const canStartOver = canMake && (!current || current.status === 'blocked' || current.status === 'failed');

  return (
    <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
      <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <VideoBird className="w-[22px] h-4" /> Flow
        </span>
        <span className="text-[10px] text-g2-muted font-medium normal-case tracking-normal shrink-0 ml-3">AI video</span>
      </h3>

      {canMake && meter && <MeterBar meter={meter} />}

      {current ? <Status w={current} meter={meter} config={config} canMake={canMake} /> : (
        <p className="text-[13px] leading-relaxed text-g2-secondary">
          Pick a few photos and AI turns them into a short, silent video that moves from one to the next. You check it before anyone else sees it.
        </p>
      )}

      {canStartOver && (
        <button type="button" onClick={() => setStudioOpen(true)} className={`w-full ${primary}`}>
          <Clapperboard className="w-[18px] h-[18px]" aria-hidden="true" />
          {current ? 'Pick different photos' : 'Make a Flow'}
        </button>
      )}

      <AnimatePresence>
        {studioOpen && <Studio key="studio" photos={photos} config={config} meter={meter} onClose={() => setStudioOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}

/** Seconds of AI video left: each second made, including redos, comes off this. */
function MeterBar({ meter, adding = 0 }: { meter: FlowMeter; adding?: number }) {
  const { allowanceSeconds: all, remainingSeconds: left } = meter;
  const usedShare = all > 0 ? (all - left) / all : 1;
  const addShare = all > 0 ? Math.min(adding, left) / all : 0;
  return (
    <div className="space-y-1.5" aria-live="polite">
      <p className="flex justify-between gap-3 text-[12px] font-bold text-g2-secondary">
        <span>AI video seconds</span>
        <span className="font-mono text-white">{adding > 0 ? `${adding} of ${left} sec` : `${left} of ${all} sec left`}</span>
      </p>
      <div className="h-2 rounded-full bg-white/10 overflow-hidden flex" aria-hidden="true">
        <div className="h-full bg-white/25" style={{ width: `${usedShare * 100}%` }} />
        <div className="h-full bg-g2-blue transition-[width] duration-300" style={{ width: `${addShare * 100}%` }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ one video's state
function Status({ w, meter, config, canMake }: { w: Walkthrough; meter: FlowMeter | null; config: WalkthroughConfig; canMake: boolean }) {
  const { event } = useEvent();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message || 'That didn\'t work. Try again.');
    } finally {
      setBusy('');
    }
  };
  const remove = () => {
    if (window.confirm('Delete this video for good? The AI seconds it used don\'t come back.')) {
      act('delete', () => deleteWalkthrough(event.id, w.id));
    }
  };

  if (walkthroughBusy(w)) return <Progress w={w} />;

  if (w.status === 'blocked' || w.status === 'failed') {
    const failedClip = w.clips.find((c) => c.status !== 'ready');
    return (
      <div className="space-y-3">
        <p className="flex gap-2 text-[13px] leading-relaxed text-amber-200" role="alert">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          {w.error || "The video didn't finish."}
        </p>
        <div className="flex gap-2">
          {w.status === 'failed' && canMake && (
            <button type="button" disabled={!!busy} className={`flex-1 ${secondary}`}
              onClick={() => act('retry', () => redoWalkthroughClip(event.id, w.id, failedClip?.index ?? 0))}>
              {busy === 'retry' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-4 h-4" aria-hidden="true" />}
              Try again
            </button>
          )}
          <button type="button" disabled={!!busy} onClick={remove} className={`flex-1 ${danger}`}>
            <Trash2 className="w-4 h-4" aria-hidden="true" /> Delete
          </button>
        </div>
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
      </div>
    );
  }

  const published = w.status === 'published';
  // A redo remakes one clip, so it needs one clip's worth of seconds.
  const canRedo = !meter || meter.remainingSeconds >= config.clipSeconds;
  const labelOn = w.showLabel !== false;
  return (
    <div className="space-y-3">
      <p className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full font-mono text-[10px] font-bold tracking-[0.06em] uppercase ${
        published ? 'bg-g2-blue text-white' : 'border border-g2-tertiary text-g2-secondary'
      }`}>
        {published ? <><Check className="w-3 h-3" aria-hidden="true" /> In the gallery and on TVs</> : 'Only you can see this'}
      </p>
      <div className={w.aspect === '9:16' ? 'max-w-[260px] mx-auto' : ''}>
        <WalkthroughVideo w={w} className="w-full" />
      </div>
      <WalkthroughLabel className="text-center" />
      {w.redoNotice && <p className="flex gap-2 text-[12px] leading-relaxed text-amber-200" role="alert">
        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />{w.redoNotice}
      </p>}

      {!published && (
        <>
          <button type="button" disabled={!!busy} className={`w-full ${primary}`} onClick={() => act('approve', () => approveWalkthrough(event.id, w.id))}>
            {busy === 'approve' ? <Loader2 className="w-[18px] h-[18px] animate-spin" aria-hidden="true" /> : <Check className="w-[18px] h-[18px]" aria-hidden="true" />}
            Approve and share with guests
          </button>
          {canMake && (
            <div className="space-y-1.5">
              <p className="text-[12px] text-g2-tertiary">
                {canRedo ? `Don't like a part? Redo just that clip. It uses ${config.clipSeconds} seconds.` : 'Not enough seconds left for a redo.'}
              </p>
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(w.clips.length, 3)}, minmax(0, 1fr))` }}>
                {w.clips.map((c) => (
                  <button key={c.index} type="button" disabled={!!busy || !canRedo} className={secondary}
                    onClick={() => act(`redo${c.index}`, () => redoWalkthroughClip(event.id, w.id, c.index))}>
                    {busy === `redo${c.index}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
                    Clip {c.index + 1}
                  </button>
                ))}
              </div>
            </div>
          )}
          {canMake && (
            <button type="button" disabled={!!busy} role="switch" aria-checked={labelOn}
              onClick={() => {
                if (labelOn && !window.confirm("Turn off the AI label on the video? Copies people save or share won't say it's AI-generated.")) return;
                act('label', () => setFlowLabel(event.id, w.id, !labelOn));
              }}
              className={`w-full ${secondary}`}>
              {busy === 'label' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}
              AI label on the video: {labelOn ? 'On' : 'Off'}
            </button>
          )}
        </>
      )}

      <div className="flex gap-2">
        {published && (
          <button type="button" disabled={!!busy} className={`flex-1 ${secondary}`} onClick={() => act('unpublish', () => unpublishWalkthrough(event.id, w.id))}>
            {busy === 'unpublish' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : null}
            Take it down
          </button>
        )}
        <button type="button" disabled={!!busy} onClick={remove} className={`flex-1 ${danger}`}>
          <Trash2 className="w-4 h-4" aria-hidden="true" /> Delete
        </button>
      </div>
      {published && <p className="text-[11px] text-g2-muted">Taking it down hides it right away. Anyone who already saved it keeps their copy.</p>}
      {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
    </div>
  );
}

function Progress({ w }: { w: Walkthrough }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const total = w.clips.length;
  const done = clipsDone(w);
  const joining = w.status === 'joining';
  const share = joining ? 0.95 : (done + 0.15) / (total + 0.5);
  return (
    <div className="space-y-2.5" aria-live="polite">
      <p className="flex items-center gap-2 text-[14px] font-bold text-white">
        <Loader2 className="w-4 h-4 animate-spin text-g2-blue-light" aria-hidden="true" />
        {w.status === 'queued' ? 'Starting…' : joining ? 'Putting it together…' : `Making clip ${Math.min(done + 1, total)} of ${total}…`}
      </p>
      {/* The bird flies along the bar while the host waits */}
      <div className="relative pt-5" aria-hidden="true">
        <VideoBird flying className="absolute top-0 w-[30px] h-[22px] -translate-x-1/2 transition-[left] duration-500" style={{ left: `clamp(15px, ${Math.round(share * 100)}%, calc(100% - 15px))` }} />
        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-g2-blue transition-[width] duration-500" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      </div>
      <p className="text-[12px] leading-relaxed text-g2-tertiary">
        {walkthroughSlow(w, now)
          ? "It's taking longer than usual. It will keep trying on its own."
          : "This usually takes a few minutes. You can leave: it keeps going, and you'll see it here when you come back."}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ making one
function Studio({ photos, config, meter, onClose }: { key?: string; photos: Photo[]; config: WalkthroughConfig; meter: FlowMeter | null; onClose: () => void }) {
  const { event } = useEvent();
  useBackToClose(true, onClose);
  const approved = useMemo(
    () => photos.filter((p) => p.status === 'approved').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
    [photos],
  );
  const [aspect, setAspect] = useState<WalkthroughAspect>('9:16');
  const [picked, setPicked] = useState<string[]>([]);
  const [reordered, setReordered] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [showLabel, setShowLabel] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID()); // a double tap or a lost answer still makes one video

  const byId = useMemo(() => new Map(approved.map((p) => [p.id, p])), [approved]);
  // The most photos the seconds left can pay for. Until the meter answers, the cloud job still checks.
  const affordable = meter ? Math.floor(meter.remainingSeconds / config.clipSeconds) + 1 : config.maxPhotos;
  const most = Math.min(config.maxPhotos, affordable);
  const enoughSeconds = most >= config.minPhotos;
  const enough = approved.length >= config.minPhotos;
  const full = picked.length >= most;
  const seconds = flowSeconds(picked.length, config.clipSeconds);
  const ready = picked.length >= config.minPhotos && picked.length <= most;

  const toggle = (id: string) => {
    setPicked((list) => {
      if (list.includes(id)) return list.filter((x) => x !== id);
      if (list.length >= most) return list;
      const next = [...list, id];
      // The suggested order is the order they were taken, until the host moves one.
      return reordered ? next : next.sort((a, b) => (byId.get(a)?.createdAt || 0) - (byId.get(b)?.createdAt || 0));
    });
  };
  const move = (i: number, by: number) => {
    setReordered(true);
    setPicked((list) => {
      const next = [...list];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });
  };
  const create = async () => {
    setSending(true);
    setError('');
    try {
      await createWalkthrough({ eventId: event.id, photoIds: picked, aspect, requestId: requestId.current, showLabel });
      onClose();
    } catch (e: any) {
      setError(e?.message || 'The video service is unavailable right now.');
      setSending(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] bg-g2-page/75 flex items-end sm:items-center justify-center font-sans"
      onClick={onClose}
    >
      <motion.section
        role="dialog"
        aria-modal="true"
        aria-labelledby="wt-title"
        initial={{ y: 40 }}
        animate={{ y: 0 }}
        exit={{ y: 40 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-[92dvh] overflow-y-auto bg-g2-panel border-t sm:border border-white/10 rounded-t-[20px] sm:rounded-[20px] px-5 pt-4 pb-7 flex flex-col gap-5 [&>*]:shrink-0"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">AI video</p>
            <h2 id="wt-title" className="mt-0.5 font-expanded font-black text-[22px] leading-tight text-white">Make a Flow</h2>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-bold text-g2-secondary mb-2">Shape</legend>
          <div className="flex flex-wrap gap-2">
            <Choice active={aspect === '9:16'} onClick={() => setAspect('9:16')}><Smartphone className="w-4 h-4" aria-hidden="true" /> Vertical</Choice>
            <Choice active={aspect === '16:9'} onClick={() => setAspect('16:9')}><Monitor className="w-4 h-4" aria-hidden="true" /> Horizontal</Choice>
          </div>
        </fieldset>

        <div>
          <p className="text-xs font-bold text-g2-secondary mb-2" aria-live="polite">
            Pick {config.minPhotos} to {most} photos{' '}
            <span className="font-mono text-g2-tertiary">({picked.length} picked{picked.length ? `, ${seconds} sec` : ''})</span>
          </p>
          {meter && <div className="mb-3"><MeterBar meter={meter} adding={seconds} /></div>}
          {!enoughSeconds ? (
            <p className="text-[13px] text-amber-200">There aren't enough AI video seconds left for a new Flow.</p>
          ) : !enough ? (
            <p className="text-[13px] text-amber-200">This needs at least {config.minPhotos} approved photos, and there {approved.length === 1 ? 'is' : 'are'} {approved.length} so far.</p>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-1.5 max-h-[34dvh] overflow-y-auto">
              {approved.map((p) => {
                const at = picked.indexOf(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggle(p.id)}
                    aria-pressed={at >= 0}
                    aria-label={`Photo by ${p.nickname}${at >= 0 ? `, number ${at + 1}` : ''}`}
                    disabled={at < 0 && full}
                    className={`relative aspect-square rounded-lg overflow-hidden bg-black cursor-pointer disabled:cursor-not-allowed ${at >= 0 ? 'ring-2 ring-g2-blue' : at < 0 && full ? 'opacity-40' : ''}`}
                  >
                    <img src={p.url} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                    {at >= 0 && (
                      <span className="absolute top-1 left-1 w-6 h-6 rounded-full bg-g2-blue text-white font-mono text-[12px] font-bold flex items-center justify-center">{at + 1}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {picked.length > 1 && (
          <div>
            <p className="text-xs font-bold text-g2-secondary mb-2">Order <span className="font-normal text-g2-tertiary">{reordered ? '(yours)' : '(as they were taken)'}</span></p>
            <ol className="space-y-1.5">
              {picked.map((id, i) => (
                <li key={id} className="flex items-center gap-2.5 p-1.5 rounded-lg border border-white/[0.08]">
                  <span className="w-5 text-center font-mono text-[12px] font-bold text-g2-tertiary">{i + 1}</span>
                  <img src={byId.get(id)?.url} alt="" className="w-11 h-11 rounded-md object-cover bg-black" />
                  <span className="flex-1 min-w-0 text-[12px] text-g2-secondary truncate">@{byId.get(id)?.nickname.replace(/\s*\(.*\)$/, '')}</span>
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move photo ${i + 1} earlier`} className="w-10 h-10 rounded-lg border border-white/15 text-white disabled:opacity-25 flex items-center justify-center cursor-pointer disabled:cursor-default">
                    <ArrowUp className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <button type="button" disabled={i === picked.length - 1} onClick={() => move(i, 1)} aria-label={`Move photo ${i + 1} later`} className="w-10 h-10 rounded-lg border border-white/15 text-white disabled:opacity-25 flex items-center justify-center cursor-pointer disabled:cursor-default">
                    <ArrowDown className="w-4 h-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}

        <label className="flex gap-3 items-start cursor-pointer">
          <input
            type="checkbox"
            checked={showLabel}
            onChange={(e) => setShowLabel(e.target.checked)}
            className="mt-0.5 w-5 h-5 shrink-0 accent-[var(--color-g2-blue)] cursor-pointer"
          />
          <span className="text-[13px] leading-relaxed text-white">
            Show a small AI label on the video
            {!showLabel && <span className="block text-amber-200">Copies people save or share won't say it's AI-generated. The note in the app stays.</span>}
          </span>
        </label>

        <label className="flex gap-3 p-3.5 rounded-xl border border-amber-300/30 bg-amber-300/5 cursor-pointer">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 w-5 h-5 shrink-0 accent-[var(--color-g2-blue)] cursor-pointer"
          />
          <span className="text-[13px] leading-relaxed text-white">{WALKTHROUGH_NOTICE}</span>
        </label>

        {error && <p className="text-[13px] text-red-400" role="alert">{error}</p>}
        <button type="button" onClick={create} disabled={!ready || !accepted || sending} className={`w-full ${primary}`}>
          {sending ? <Loader2 className="w-[18px] h-[18px] animate-spin" aria-hidden="true" /> : <Clapperboard className="w-[18px] h-[18px]" aria-hidden="true" />}
          {sending ? 'Starting…' : ready ? `Create ${seconds}-second Flow` : 'Create'}
        </button>
      </motion.section>
    </motion.div>
  );
}

function Choice({ active, onClick, children }: { key?: string; active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-11 px-4 rounded-xl border text-[13px] font-bold inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
        active ? 'bg-g2-blue border-g2-blue text-white' : 'border-white/15 bg-white/5 text-g2-secondary hover:text-white hover:border-white/30'
      }`}
    >
      {children}
    </button>
  );
}

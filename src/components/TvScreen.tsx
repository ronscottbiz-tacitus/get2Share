import React, { useEffect, useMemo, useRef, useState } from 'react';
import { deleteDoc, getDoc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { useQr } from '../useQr';
import { groupShotClock } from '../groupShot';
import { AnimatePresence, motion } from 'motion/react';
import Get2ShareLockup from './Get2ShareLockup';
import FullscreenButton from './FullscreenButton';
import { EventWithId, eventPhase, formatDay, joinUrl, paths } from '../events';
import { formatPairingCode } from '../spotPairing';
import {
  createScreenCode, ScreenConfig, ScreenPairing, screenPaths, SCREEN_CODE_TTL_MS, STORED_SCREEN_KEY,
} from '../screens';
import { Photo } from '../types';

// share.get2.one/tv: a smart TV (or any big screen) that shows an event's photos.
// Built for viewing from across the room: everything sized from the screen
// (vmin), nothing near the edges (TVs crop them), no remote needed once paired.

// "Just in": each new photo gets the whole screen for a moment. When photos come in
// faster than that, the TV keeps up instead of falling behind:
const JUST_IN_MS = 7000;        // a photo with nothing waiting behind it
const JUST_IN_BUSY_MS = 4000;   // a photo with more waiting
const JUST_IN_MAX_WAITING = 3;  // more than this waiting: jump to the newest, the rest stay on the wall
const WALL_BREATHER_MS = 4000;  // between pop-ups on a busy night, the wall gets the screen
// A TV reopened this long after its event ended starts fresh with a new pairing code,
// instead of going back to the old event. (Same night, it still reconnects.)
const RELEASE_AFTER_END_MS = 6 * 60 * 60 * 1000;
const SLIDE_MS = 8000;
const HEARTBEAT_MS = 60000;

function readStoredCode() {
  try { return localStorage.getItem(STORED_SCREEN_KEY); } catch { return null; }
}
function storeCode(code: string | null) {
  try {
    if (code) localStorage.setItem(STORED_SCREEN_KEY, code);
    else localStorage.removeItem(STORED_SCREEN_KEY);
  } catch { /* ignore */ }
}

function cleanName(nickname: string) {
  return nickname.replace(/\s*\((Tripod|Photo Spot|Share Spot|Group Shot)\)$/, '');
}
/** Who took it, and where: "@maya", "Photo Wall" (a Share Spot), or "@jo · Group Shot". */
function credit(p: Photo): { who: string; where: string } {
  const name = cleanName(p.nickname || '');
  if (/\((Tripod|Photo Spot|Share Spot)\)$/.test(p.nickname || '')) return { who: '', where: name };
  if (/\(Group Shot\)$/.test(p.nickname || '')) return { who: `@${name}`, where: 'Group Shot' };
  return { who: `@${name}`, where: '' };
}

export default function TvScreen({ uid }: { uid: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [pairing, setPairing] = useState<ScreenPairing | null>(null);
  const [joined, setJoined] = useState(false);
  const [config, setConfig] = useState<ScreenConfig | null>(null);
  const [event, setEvent] = useState<EventWithId | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const hadConfig = useRef(false);

  const reset = () => {
    storeCode(null);
    hadConfig.current = false;
    setJoined(false);
    setConfig(null);
    setEvent(null);
    setPhotos([]);
    setPairing(null);
    setCode(null);
  };

  // Leave the current event and show a new pairing code (the TV's own pairing is deleted).
  const release = () => {
    if (code) deleteDoc(screenPaths.pairing(code)).catch(() => {});
    reset();
  };

  // An event whose album has closed while this TV is on: start fresh.
  const expiredNow = !!event && eventPhase(event, now) === 'expired';
  useEffect(() => { if (expiredNow) release(); }, [expiredNow]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Keep the TV awake where the browser allows it.
  useEffect(() => {
    let lock: any = null;
    const ask = () => (navigator as any).wakeLock?.request?.('screen').then((l: any) => (lock = l)).catch(() => {});
    ask();
    const onVis = () => document.visibilityState === 'visible' && ask();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      lock?.release?.().catch?.(() => {});
    };
  }, []);

  // 1. Get a code: reuse this TV's stored one if it's still good, else make a new one.
  useEffect(() => {
    if (code) return;
    let cancelled = false;
    (async () => {
      try {
        const stored = readStoredCode();
        if (stored) {
          const snap = await getDoc(screenPaths.pairing(stored)).catch(() => null);
          const p = snap?.exists() ? (snap.data() as ScreenPairing) : null;
          const fresh = p && (p.claimedBy || Date.now() - (p.createdAt?.toMillis?.() ?? 0) < SCREEN_CODE_TTL_MS);
          if (p && p.screenUid === uid && fresh) {
            if (!(p.claimedBy && p.eventId) || !(await eventIsOver(p.eventId))) {
              if (!cancelled) setCode(stored);
              return;
            }
            // That event is long over (or gone): let it go and pair fresh.
            await deleteDoc(screenPaths.pairing(stored)).catch(() => {});
            storeCode(null);
          }
        }
        const c = await createScreenCode(uid);
        if (cancelled) return;
        storeCode(c);
        setCode(c);
        setError('');
      } catch (e) {
        console.error('Screen code failed:', e);
        if (!cancelled) setError("Couldn't get a screen code. Check the TV's internet connection; retrying…");
        setTimeout(() => !cancelled && setCode(null), 10000);
      }
    })();
    return () => { cancelled = true; };
  }, [code, uid]);

  // 2. Watch the code: a host claiming it tells this TV which event to show.
  useEffect(() => {
    if (!code) return;
    return onSnapshot(
      screenPaths.pairing(code),
      (snap) => {
        if (!snap.exists()) { reset(); return; } // host removed it, or it was cleaned up
        setPairing(snap.data() as ScreenPairing);
      },
      () => {}
    );
  }, [code]);

  // Unclaimed codes refresh every 15 minutes.
  const createdMs = pairing?.createdAt?.toMillis?.() ?? null;
  const expiresIn = createdMs ? createdMs + SCREEN_CODE_TTL_MS - now : SCREEN_CODE_TTL_MS;
  useEffect(() => {
    if (!code || !pairing || pairing.claimedBy || expiresIn > 0) return;
    deleteDoc(screenPaths.pairing(code)).catch(() => {});
    reset();
  }, [expiresIn <= 0, pairing?.claimedBy, code]);

  // 3. Claimed: join the event as a screen.
  const eventId = pairing?.eventId ?? null;
  useEffect(() => {
    if (!eventId || !code || joined) return;
    let cancelled = false;
    (async () => {
      try {
        const ref = paths.member(eventId, uid);
        const exists = await getDoc(ref).then((d) => d.exists()).catch(() => false);
        if (!exists) {
          await setDoc(ref, { nickname: pairing?.screenName || 'Screen', joinedAt: serverTimestamp(), joinCode: code, role: 'screen' });
        }
        if (!cancelled) setJoined(true);
      } catch (e) {
        console.error('Screen join failed:', e);
        if (!cancelled) setError("Couldn't connect to the event. Ask the host to add this screen again.");
      }
    })();
    return () => { cancelled = true; };
  }, [eventId, code, joined]);

  // 4. Settings, event and photos.
  useEffect(() => {
    if (!joined || !eventId) return;
    const unsubCfg = onSnapshot(screenPaths.screen(eventId, uid), (snap) => {
      if (!snap.exists()) {
        if (hadConfig.current) reset(); // the host removed this screen
        return;
      }
      hadConfig.current = true;
      setConfig(snap.data() as ScreenConfig);
    }, () => {});
    const unsubEvent = onSnapshot(paths.event(eventId), (snap) => {
      if (!snap.exists()) { reset(); return; }
      setEvent({ id: snap.id, ...(snap.data() as any) } as EventWithId);
    }, () => {});
    const unsubPhotos = onSnapshot(query(paths.photos(eventId), where('status', '==', 'approved')), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }) as Photo);
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setPhotos(list);
    }, () => {});
    return () => { unsubCfg(); unsubEvent(); unsubPhotos(); };
  }, [joined, eventId]);

  // "Still on" check-in, so the Host Console can show it online.
  useEffect(() => {
    if (!joined || !eventId || !config) return;
    const beat = () => updateDoc(screenPaths.screen(eventId, uid), { lastSeen: serverTimestamp() }).catch(() => {});
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [joined, eventId, !!config]);

  const pairUrl = code ? `${window.location.origin}/host?screen=${code}` : null;
  const pairQr = useQr(pairUrl, 420);

  // ---------- Render ----------
  if (!joined || !event || !config) {
    return (
      <TvFrame onSwitch={pairing?.claimedBy ? release : undefined}>
        {pairing?.claimedBy ? (
          <Centered>
            <p className="text-[3vmin] text-g2-secondary">Connecting to</p>
            <p className="mt-[1vmin] font-expanded font-black text-[7vmin] leading-none text-white">{pairing.screenName || 'the event'}…</p>
            {error && <p className="mt-[3vmin] text-[2.6vmin] text-red-300">{error}</p>}
          </Centered>
        ) : (
          <PairingView code={code} qr={pairQr} expiresIn={expiresIn} error={error} />
        )}
      </TvFrame>
    );
  }

  return <EventView event={event} config={config} photos={photos} now={now} onSwitch={release} />;
}

/** Did this event end long ago, or is it gone? Network trouble counts as "no" so a live TV keeps reconnecting. */
async function eventIsOver(eventId: string): Promise<boolean> {
  try {
    const snap = await getDoc(paths.event(eventId));
    if (!snap.exists()) return true;
    const ev = snap.data() as EventWithId;
    const end = (ev as any).endsAt?.toMillis?.();
    return eventPhase(ev) === 'expired' || (!!end && Date.now() > end + RELEASE_AFTER_END_MS);
  } catch (e: any) {
    return e?.code === 'permission-denied'; // removed from the event
  }
}

/**
 * "Pair with a different event": hidden until someone moves a mouse or presses a remote
 * key, then a small button bottom-right. Press once to arm, again within 5 s to switch.
 */
function SwitchEventButton({ onSwitch }: { onSwitch: () => void }) {
  const [shown, setShown] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const wake = () => { setShown(true); clearTimeout(t); t = setTimeout(() => { setShown(false); setArmed(false); }, 6000); };
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', wake);
    return () => { window.removeEventListener('mousemove', wake); window.removeEventListener('keydown', wake); clearTimeout(t); };
  }, []);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      onFocus={() => setShown(true)}
      onClick={() => (armed ? onSwitch() : setArmed(true))}
      className={`absolute bottom-[2.4vmin] right-[3vmin] z-50 rounded-full border px-[2.2vmin] py-[1vmin] font-mono text-[1.8vmin] font-bold tracking-[0.08em] uppercase transition-opacity duration-300 cursor-pointer focus:outline-none focus-visible:ring-4 focus-visible:ring-g2-blue ${
        shown ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100'
      } ${armed ? 'bg-g2-blue border-g2-blue text-white' : 'bg-g2-page/80 border-white/20 text-g2-secondary'}`}
    >
      {armed ? 'Press again to switch events' : 'Pair with a different event'}
    </button>
  );
}

function TvFrame({ children, onSwitch }: { children: React.ReactNode; onSwitch?: () => void }) {
  // The pointer hides on a TV, but shows again while a mouse is moving (a laptop casting to the TV).
  const [pointer, setPointer] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const wake = () => { setPointer(true); clearTimeout(t); t = setTimeout(() => setPointer(false), 3000); };
    window.addEventListener('mousemove', wake);
    return () => { window.removeEventListener('mousemove', wake); clearTimeout(t); };
  }, []);
  return (
    <div className={`fixed inset-0 bg-g2-page text-g2-text font-sans overflow-hidden select-none p-[5vmin] flex flex-col ${pointer ? '' : 'cursor-none'}`}>
      {children}
      <FullscreenButton autoFocus label="Press OK for full screen" className="absolute top-[1.2vmin] left-1/2 -translate-x-1/2 text-[1.9vmin] px-[2vmin] py-[0.9vmin] z-50" />
      {onSwitch && <SwitchEventButton onSwitch={onSwitch} />}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 flex flex-col items-center justify-center text-center">{children}</div>;
}

function PairingView({ code, qr, expiresIn, error }: { code: string | null; qr: string; expiresIn: number; error: string }) {
  const mins = Math.max(0, Math.floor(expiresIn / 60000));
  const secs = String(Math.max(0, Math.floor((expiresIn % 60000) / 1000))).padStart(2, '0');
  return (
    <>
      <header className="flex justify-between items-center">
        <Get2ShareLockup className="text-[4vmin]" />
        <span className="font-mono text-[2vmin] font-bold tracking-[0.1em] uppercase text-g2-tertiary">Screen setup</span>
      </header>
      <div className="flex-1 grid grid-cols-2 gap-[6vmin] items-center">
        <div>
          <h1 className="font-expanded font-black text-[8vmin] leading-[1.02] tracking-[-0.02em] text-white">Put the party on this screen.</h1>
          <ol className="mt-[4vmin] flex flex-col gap-[2.4vmin]">
            {[
              <>On your phone, open the <b className="text-white">Host Console</b>.</>,
              <>Tap <b className="text-white">Screens → Add a screen</b>, then scan the code or type it in.</>,
              <>That's it. No remote needed after this.</>,
            ].map((t, i) => (
              <li key={i} className="flex gap-[2vmin] items-start">
                <span className="w-[5vmin] h-[5vmin] shrink-0 rounded-full bg-g2-panel border border-white/15 flex items-center justify-center font-expanded font-black text-[2.4vmin] text-white">{i + 1}</span>
                <p className="mt-[0.6vmin] text-[3vmin] leading-snug text-g2-secondary">{t}</p>
              </li>
            ))}
          </ol>
        </div>
        <div className="flex flex-col items-center gap-[3vmin]">
          <div className="w-full max-w-[64vmin] p-[4vmin] rounded-[2.4vmin] bg-g2-panel border border-white/10 flex flex-col items-center gap-[3vmin]">
            <p className="font-condensed font-extrabold text-[2.2vmin] tracking-[0.16em] uppercase text-g2-blue-light">Screen code</p>
            <p className="font-mono font-bold text-[11vmin] leading-none tracking-[0.12em] text-white">{code ? formatPairingCode(code) : '······'}</p>
            <div className="flex items-center gap-[3vmin]">
              <div className="w-[18vmin] h-[18vmin] rounded-[1.4vmin] bg-white p-[1vmin] flex items-center justify-center">
                {qr ? <img src={qr} alt="" className="w-full h-full" /> : null}
              </div>
              <p className="w-[26vmin] text-[2.3vmin] leading-snug text-g2-secondary">Or scan with the host's phone to connect instantly.</p>
            </div>
          </div>
          <p className="font-mono text-[2vmin] font-bold tracking-[0.06em] text-g2-tertiary flex items-center gap-[1.2vmin]">
            <span className="w-[1.2vmin] h-[1.2vmin] rounded-full bg-g2-blue animate-pulse" />
            Waiting for the host{code ? ` · new code in ${mins}:${secs}` : ''}
          </p>
          {error && <p className="text-[2.4vmin] text-red-300 text-center">{error}</p>}
        </div>
      </div>
      <footer className="flex justify-between items-end">
        <span className="font-mono text-[2vmin] text-g2-tertiary">{window.location.host}/tv</span>
        <Tagline />
      </footer>
    </>
  );
}

function Tagline() {
  return (
    <span aria-label="You get to be in the picture." className="font-expanded font-black text-[2.6vmin] text-white">
      <span aria-hidden="true">You <span className="text-g2-blue">Get2</span> be in the picture.</span>
    </span>
  );
}

function EventView({ event, config, photos, now, onSwitch }: { event: EventWithId; config: ScreenConfig; photos: Photo[]; now: number; onSwitch: () => void }) {
  const link = joinUrl(event.joinCode);
  const qr = useQr(link, 320);
  const phase = eventPhase(event, now);

  const current = useJustIn(photos);

  if (config.paused) {
    return (
      <TvFrame onSwitch={onSwitch}>
        <header className="flex justify-between items-center">
          <Get2ShareLockup className="text-[4vmin]" />
        </header>
        <Centered>
          <p className="font-expanded font-black text-[8vmin] leading-tight text-white">{event.name}</p>
          <p className="mt-[2vmin] text-[3.2vmin] text-g2-secondary">Back in a moment.</p>
          {config.showQr && <JoinCard qr={qr} link={link} big />}
        </Centered>
      </TvFrame>
    );
  }

  const justIn = config.layout !== 'justin' && current;
  // After the party, the TV leads with the crowd favorites.
  const shown = phase === 'album' || phase === 'expired'
    ? [...photos].sort((a, b) => (b.reactions?.likes || 0) - (a.reactions?.likes || 0) || (b.createdAt || 0) - (a.createdAt || 0))
    : photos;

  return (
    <TvFrame onSwitch={onSwitch}>
      <header className="flex justify-between items-center gap-[3vmin]">
        <div className="flex items-baseline gap-[3vmin] min-w-0">
          <Get2ShareLockup className="text-[3.6vmin] shrink-0" />
          <span className="font-expanded font-extrabold text-[3.4vmin] text-g2-secondary truncate">{event.name}</span>
        </div>
        <span className="flex items-center gap-[1.2vmin] font-mono text-[2.2vmin] font-bold tracking-[0.08em] uppercase text-white shrink-0">
          <span className={`w-[1.4vmin] h-[1.4vmin] rounded-full ${phase === 'live' || phase === 'wrapup' ? 'bg-g2-live' : 'bg-g2-muted'}`} />
          {phase === 'live' || phase === 'wrapup' ? 'Live' : 'Album'} · {photos.length} {photos.length === 1 ? 'photo' : 'photos'}
        </span>
      </header>

      <div className="flex-1 min-h-0 mt-[3vmin] flex gap-[3vmin]">
        <div className="flex-1 min-w-0 relative">
          {photos.length === 0 ? (
            <EmptyState qr={qr} link={link} />
          ) : config.layout === 'justin' ? (
            <Spotlight photos={shown} showNames={config.showNames} />
          ) : config.layout === 'slideshow' ? (
            <Slideshow photos={shown} showNames={config.showNames} jumpTo={current?.id ?? null} />
          ) : (
            <Wall photos={shown} showNames={config.showNames} />
          )}

          <AnimatePresence>
            {justIn && (
              <motion.div
                key={justIn.id}
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.45 }}
                className="absolute inset-0 rounded-[2vmin] overflow-hidden bg-black"
              >
                <img src={justIn.url} alt="" className="absolute inset-0 w-full h-full object-contain" />
                <JustInBar photo={justIn} showNames={config.showNames} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <GroupShotTv event={event} />

        {(config.showQr || phase === 'album' || phase === 'expired') && photos.length > 0 && (
          <aside className="w-[30vmin] shrink-0 flex flex-col gap-[2vmin]">
            {(phase === 'album' || phase === 'expired') && (
              <div className="rounded-[1.6vmin] bg-g2-panel border border-g2-blue/40 p-[2.4vmin]">
                <p className="font-expanded font-black text-[3vmin] text-white">That's a wrap.</p>
                <p className="mt-[0.8vmin] text-[2vmin] leading-snug text-g2-secondary">
                  {event.expireAt ? `The album is open until ${formatDay(event.expireAt.toMillis())}. Save your photos before then.` : 'Thanks for coming.'}
                </p>
              </div>
            )}
            {config.showQr && <JoinCard qr={qr} link={link} />}
          </aside>
        )}
      </div>

      <footer className="mt-[3vmin] flex justify-between items-center">
        <Tagline />
        <span className="font-mono text-[1.9vmin] text-g2-tertiary">
          {phase === 'live' || phase === 'wrapup' ? 'New photos appear here as they’re taken' : 'Thanks for coming'}
        </span>
      </footer>
    </TvFrame>
  );
}

/**
 * "Just in": photos that arrive after this screen started showing the event, one at a time.
 * A quiet party gets 7 seconds per photo. A busy one gets shorter turns with the wall in
 * between, and when a line builds up it skips to the newest, so the TV is never minutes behind.
 */
export function pickJustIn(waiting: Photo[]): { show: Photo | null; rest: Photo[]; ms: number } {
  if (!waiting.length) return { show: null, rest: [], ms: 0 };
  if (waiting.length > JUST_IN_MAX_WAITING) {
    return { show: waiting[waiting.length - 1], rest: [], ms: JUST_IN_MS };
  }
  const [show, ...rest] = waiting;
  return { show, rest, ms: rest.length ? JUST_IN_BUSY_MS : JUST_IN_MS };
}

function useJustIn(photos: Photo[]): Photo | null {
  const seen = useRef<Set<string> | null>(null);
  const [waiting, setWaiting] = useState<Photo[]>([]);
  const [current, setCurrent] = useState<{ photo: Photo; until: number } | null>(null);
  const [restingUntil, setRestingUntil] = useState(0);
  const [, tick] = useState(0);

  // New arrivals join the line, oldest first.
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(photos.map((p) => p.id));
      return;
    }
    const fresh = photos.filter((p) => !seen.current!.has(p.id));
    if (fresh.length) {
      fresh.forEach((p) => seen.current!.add(p.id));
      setWaiting((w) => [...w, ...fresh.slice().reverse()]);
    }
    // A photo the host removed leaves the line (and the screen).
    const live = new Set(photos.map((p) => p.id));
    setWaiting((w) => (w.every((p) => live.has(p.id)) ? w : w.filter((p) => live.has(p.id))));
    setCurrent((c) => (c && !live.has(c.photo.id) ? null : c));
  }, [photos]);

  useEffect(() => {
    const now = Date.now();
    if (current) {
      const t = setTimeout(() => {
        setCurrent(null);
        // Someone's waiting: let the wall show for a few seconds first.
        setRestingUntil(Date.now() + WALL_BREATHER_MS);
      }, Math.max(0, current.until - now));
      return () => clearTimeout(t);
    }
    if (!waiting.length) return;
    if (now < restingUntil) {
      const t = setTimeout(() => tick((n) => n + 1), restingUntil - now);
      return () => clearTimeout(t);
    }
    const { show, rest, ms } = pickJustIn(waiting);
    setWaiting(rest);
    if (show) setCurrent({ photo: show, until: now + ms });
  }, [current, waiting, restingUntil]);

  return current?.photo ?? null;
}

function JoinCard({ qr, link, big = false }: { qr: string; link: string; big?: boolean }) {
  return (
    <div className={`rounded-[1.6vmin] bg-g2-panel border border-white/10 p-[2.4vmin] flex flex-col items-center gap-[1.6vmin] ${big ? 'mt-[4vmin]' : ''}`}>
      <div className={`${big ? 'w-[30vmin] h-[30vmin]' : 'w-[22vmin] h-[22vmin]'} rounded-[1.2vmin] bg-white p-[1vmin]`}>
        {qr ? <img src={qr} alt="" className="w-full h-full" /> : null}
      </div>
      <div className="text-center">
        <p className="font-expanded font-black text-[3vmin] text-white">Scan to join</p>
        <p className="mt-[0.4vmin] font-mono text-[1.8vmin] text-g2-secondary break-all">{link.replace(/^https?:\/\//, '')}</p>
      </div>
    </div>
  );
}

function EmptyState({ qr, link }: { qr: string; link: string }) {
  return (
    <div className="absolute inset-0 rounded-[2vmin] border border-dashed border-white/15 flex items-center justify-center gap-[6vmin] px-[5vmin]">
      <div className="max-w-[60vmin]">
        <p className="font-expanded font-black text-[6.5vmin] leading-[1.05] text-white">The first photo of the night goes here.</p>
        <p className="mt-[2vmin] text-[2.8vmin] text-g2-secondary">Scan the code, pick a nickname, and take one.</p>
      </div>
      <JoinCard qr={qr} link={link} />
    </div>
  );
}

function Caption({ photo, showNames, size = 'md' }: { photo: Photo; showNames: boolean; size?: 'sm' | 'md' }) {
  const { who, where } = credit(photo);
  const shownWho = showNames ? who : '';
  if (!shownWho && !where) return null;
  return (
    <span className={`absolute left-[1.2vmin] bottom-[1.2vmin] max-w-[90%] truncate rounded-full bg-g2-page/75 font-mono font-bold text-white ${size === 'sm' ? 'text-[1.7vmin] px-[1.4vmin] py-[0.5vmin]' : 'text-[2.2vmin] px-[1.8vmin] py-[0.7vmin]'}`}>
      {shownWho}{shownWho && where ? ' · ' : ''}{where}
      {(photo.reactions?.likes ?? 0) > 0 && <span className="text-rose-300">{shownWho || where ? '  ' : ''}♥ {photo.reactions.likes}</span>}
    </span>
  );
}

/**
 * A tile that changes photos smoothly: the new photo loads out of sight, then fades in
 * over the old one, so a tile is never blank while a photo downloads.
 */
function TilePhoto({ url }: { url: string }) {
  const [layers, setLayers] = useState<{ url: string; key: number }[]>([{ url, key: 0 }]);
  const n = useRef(0);
  useEffect(() => {
    if (layers[layers.length - 1].url === url) return;
    let cancelled = false;
    const img = new Image();
    const show = () => { if (!cancelled) setLayers((l) => [...l.slice(-1), { url, key: ++n.current }]); };
    img.onload = show;
    img.onerror = show;
    img.src = url;
    return () => { cancelled = true; };
  }, [url]);
  return (
    <>
      {layers.map((l, i) => (
        <motion.div
          key={l.key}
          className="absolute inset-0"
          initial={i === 0 && layers.length === 1 ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.9 }}
          onAnimationComplete={() => { if (i === layers.length - 1 && layers.length > 1) setLayers((ls) => ls.slice(-1)); }}
        >
          <FitPhoto url={l.url} />
        </motion.div>
      ))}
    </>
  );
}

/**
 * Which photo sits in which wall tile. Tiles stay put: a new photo takes over the tile
 * holding the oldest one, instead of every photo sliding along one place.
 */
export function placeTiles(prevIds: string[], photos: Photo[], arrived: Set<string>, count: number): string[] {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const slots: (string | null)[] = prevIds.slice(0, count).map((id) => (byId.has(id) ? id : null));
  while (slots.length < count) slots.push(null);
  const onWall = () => new Set(slots.filter(Boolean) as string[]);
  // New arrivals, newest first, each take the tile of the oldest photo showing.
  const fresh = photos.filter((p) => arrived.has(p.id) && !onWall().has(p.id)).slice(0, count);
  for (const p of fresh) {
    const empty = slots.indexOf(null);
    if (empty >= 0) { slots[empty] = p.id; continue; }
    let oldest = 0;
    slots.forEach((id, i) => { if ((byId.get(id!)?.createdAt || 0) < (byId.get(slots[oldest]!)?.createdAt || 0)) oldest = i; });
    slots[oldest] = p.id;
  }
  // Any gaps (a removed photo, or the wall just grew) fill in the screen's own order.
  const shown = onWall();
  const fill = photos.filter((p) => !shown.has(p.id));
  for (let i = 0; i < slots.length; i++) if (!slots[i]) slots[i] = fill.shift()?.id ?? null;
  return slots.filter(Boolean) as string[];
}

function useStableTiles(photos: Photo[], count: number): Photo[] {
  const known = useRef<Set<string> | null>(null);
  const ids = useRef<string[]>([]);
  const arrived = new Set<string>();
  if (known.current) photos.forEach((p) => { if (!known.current!.has(p.id)) arrived.add(p.id); });
  known.current = new Set(photos.map((p) => p.id));
  ids.current = placeTiles(ids.current, photos, arrived, count);
  const byId = new Map(photos.map((p) => [p.id, p]));
  return ids.current.map((id) => byId.get(id)!).filter(Boolean);
}

/** The whole photo, never cropped: a blurred copy of it fills any spare edges. */
function FitPhoto({ url }: { url: string }) {
  return (
    <>
      <img src={url} alt="" aria-hidden="true" className="absolute inset-0 w-full h-full object-cover scale-110 blur-2xl opacity-60" />
      <img src={url} alt="" className="absolute inset-0 w-full h-full object-contain" />
    </>
  );
}

// Newest photo gets the biggest tile.
const WALL_SPANS = [
  'col-span-2 row-span-2', 'col-span-1 row-span-1', 'col-span-2 row-span-1', 'col-span-1 row-span-2',
  'col-span-2 row-span-2', 'col-span-1 row-span-1', 'col-span-1 row-span-1', 'col-span-1 row-span-1', 'col-span-2 row-span-1',
];

function Wall({ photos, showNames }: { photos: Photo[]; showNames: boolean }) {
  // 9+ photos: the full mosaic. 5–8: the big tile plus four. Fewer: an even grid.
  const count = photos.length >= WALL_SPANS.length ? WALL_SPANS.length : Math.min(photos.length, photos.length >= 5 ? 5 : 4);
  const tiles = useStableTiles(photos, count);
  if (tiles.length === 5) {
    return (
      <div className="absolute inset-0 grid grid-cols-4 grid-rows-2 gap-[1.2vmin]">
        {tiles.map((p, i) => (
          <div key={i} className={`relative rounded-[1.2vmin] overflow-hidden bg-black/40 ${i === 0 ? 'col-span-2 row-span-2' : ''}`}>
            <TilePhoto url={p.url} />
            <Caption photo={p} showNames={showNames} size={i === 0 ? 'md' : 'sm'} />
          </div>
        ))}
      </div>
    );
  }
  if (tiles.length < 5) {
    // 1: full · 2: side by side · 3: newest big with two stacked beside it · 4: 2×2
    const grid = tiles.length === 1 ? 'grid-cols-1 grid-rows-1' : tiles.length === 2 ? 'grid-cols-2 grid-rows-1' : tiles.length === 3 ? 'grid-cols-3 grid-rows-2' : 'grid-cols-2 grid-rows-2';
    return (
      <div className={`absolute inset-0 grid gap-[1.4vmin] ${grid}`}>
        {tiles.map((p, i) => (
          <div key={i} className={`relative rounded-[1.4vmin] overflow-hidden bg-black/40 ${tiles.length === 3 && i === 0 ? 'col-span-2 row-span-2' : ''}`}>
            <TilePhoto url={p.url} />
            <Caption photo={p} showNames={showNames} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="absolute inset-0 grid grid-cols-6 grid-rows-3 gap-[1.2vmin] grid-flow-dense">
      {tiles.map((p, i) => (
        <div key={i} className={`relative rounded-[1.2vmin] overflow-hidden bg-black/40 ${WALL_SPANS[i]}`}>
          <TilePhoto url={p.url} />
          <Caption photo={p} showNames={showNames} size={i === 0 ? 'md' : 'sm'} />
        </div>
      ))}
    </div>
  );
}

function Spotlight({ photos, showNames }: { photos: Photo[]; showNames: boolean }) {
  const [hero, ...rest] = photos;
  return (
    <div className="absolute inset-0 flex gap-[2vmin]">
      <div className="flex-1 relative rounded-[2vmin] overflow-hidden bg-black">
        <AnimatePresence mode="popLayout">
          <motion.img
            key={hero.id}
            src={hero.url}
            alt=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
            className="absolute inset-0 w-full h-full object-contain"
          />
        </AnimatePresence>
        <JustInBar photo={hero} showNames={showNames} label="Latest" />
      </div>
      {rest.length > 0 && (
        <div className="w-[24vmin] shrink-0 flex flex-col gap-[1.4vmin]">
          <p className="font-condensed font-extrabold text-[2vmin] tracking-[0.14em] uppercase text-g2-tertiary">Earlier</p>
          {rest.slice(0, 4).map((p) => (
            <div key={p.id} className="relative flex-1 min-h-0 rounded-[1.2vmin] overflow-hidden bg-black/40">
              <FitPhoto url={p.url} />
              <Caption photo={p} showNames={showNames} size="sm" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Slideshow({ photos, showNames, jumpTo }: { photos: Photo[]; showNames: boolean; jumpTo: string | null }) {
  const [index, setIndex] = useState(0);
  const ids = useMemo(() => photos.map((p) => p.id).join('|'), [photos]);
  useEffect(() => {
    const t = setInterval(() => setIndex((i) => (i + 1) % Math.max(1, photos.length)), SLIDE_MS);
    return () => clearInterval(t);
  }, [ids, photos.length]);
  useEffect(() => {
    if (!jumpTo) return;
    const i = photos.findIndex((p) => p.id === jumpTo);
    if (i >= 0) setIndex(i);
  }, [jumpTo]);
  const p = photos[index % photos.length];
  return (
    <div className="absolute inset-0 rounded-[2vmin] overflow-hidden bg-black">
      <AnimatePresence mode="popLayout">
        <motion.img
          key={p.id}
          src={p.url}
          alt=""
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8 }}
          className="absolute inset-0 w-full h-full object-contain"
        />
      </AnimatePresence>
      <Caption photo={p} showNames={showNames} />
      <span className="absolute right-[1.6vmin] bottom-[1.6vmin] font-mono text-[1.8vmin] text-white/70">{(index % photos.length) + 1} / {photos.length}</span>
    </div>
  );
}

/** Every TV counts the room down to a Group Shot: "Phones up!" then the flash. */
function GroupShotTv({ event }: { event: EventWithId }) {
  const gs = event.groupShot ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!gs) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [gs?.id]);
  const clock = groupShotClock(gs, now);
  if (clock === null) return null;
  const seconds = Math.max(0, Math.ceil(-clock / 1000));
  return (
    <AnimatePresence>
      <motion.div
        key={gs!.id}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className={`absolute inset-0 z-40 flex flex-col items-center justify-center gap-[3vmin] ${clock >= 0 && clock < 900 ? 'bg-white' : 'bg-g2-page/90'}`}
      >
        {clock < 0 ? (
          <>
            <p className="font-mono text-[3vmin] font-bold tracking-[0.2em] uppercase text-g2-blue-light">Group Shot</p>
            <p className="font-expanded font-black text-[9vmin] leading-none text-white">Phones up!</p>
            <motion.div
              key={seconds}
              initial={{ scale: 1.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="w-[30vmin] h-[30vmin] rounded-full border-[1vmin] border-white bg-g2-blue flex items-center justify-center"
            >
              <span className="font-expanded font-black text-[19vmin] leading-none text-white">{seconds}</span>
            </motion.div>
            <p className="text-[3vmin] text-g2-secondary">Tap “I'm in” on your phone. Every camera fires together.</p>
          </>
        ) : clock < 900 ? (
          <p className="font-expanded font-black text-[12vmin] text-g2-page">Smile!</p>
        ) : (
          <p className="font-expanded font-black text-[8vmin] text-white">Watch the photos roll in.</p>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

function JustInBar({ photo, showNames, label = 'Just in' }: { photo: Photo; showNames: boolean; label?: string }) {
  const { who, where } = credit(photo);
  const time = new Date(photo.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="absolute inset-x-0 bottom-0 px-[3vmin] py-[2.6vmin] bg-g2-page/85 flex items-end justify-between gap-[3vmin]">
      <div className="min-w-0">
        <span className="inline-flex items-center h-[4.4vmin] px-[2vmin] rounded-full bg-g2-blue font-condensed font-extrabold text-[2.2vmin] tracking-[0.16em] uppercase text-white">{label}</span>
        {(showNames && who) || (!who && where) ? (
          <p className="mt-[1.4vmin] font-expanded font-black text-[6vmin] leading-none tracking-[-0.02em] text-white truncate">
            {showNames && who ? who : where}
          </p>
        ) : null}
        <p className="mt-[1vmin] text-[2.6vmin] text-g2-secondary">
          {who && where ? <>{where} · </> : !who ? <>Share Spot · </> : null}{time}
        </p>
      </div>
    </div>
  );
}

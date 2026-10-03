import React, { useEffect, useMemo, useRef, useState } from 'react';
import { deleteDoc, getDoc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import QRCode from 'qrcode';
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

const JUST_IN_MS = 7000;
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

function useQr(text: string | null, size = 360) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!text) return;
    QRCode.toDataURL(text, { margin: 1, width: size, color: { dark: '#000000', light: '#ffffff' } })
      .then(setUrl)
      .catch(() => setUrl(''));
  }, [text, size]);
  return url;
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
            if (!cancelled) setCode(stored);
            return;
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
      <TvFrame>
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

  return <EventView event={event} config={config} photos={photos} now={now} />;
}

function TvFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-g2-page text-g2-text font-sans overflow-hidden cursor-none select-none p-[5vmin] flex flex-col">
      {children}
      <FullscreenButton autoFocus label="Press OK for full screen" className="absolute top-[1.2vmin] left-1/2 -translate-x-1/2 text-[1.9vmin] px-[2vmin] py-[0.9vmin] z-50" />
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

function EventView({ event, config, photos, now }: { event: EventWithId; config: ScreenConfig; photos: Photo[]; now: number }) {
  const link = joinUrl(event.joinCode);
  const qr = useQr(link, 320);
  const phase = eventPhase(event, now);

  // "Just in": photos that arrive after this screen started showing the event.
  const seen = useRef<Set<string> | null>(null);
  const [queue, setQueue] = useState<Photo[]>([]);
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(photos.map((p) => p.id));
      return;
    }
    const fresh = photos.filter((p) => !seen.current!.has(p.id));
    if (fresh.length) {
      fresh.forEach((p) => seen.current!.add(p.id));
      setQueue((q) => [...q, ...fresh.slice().reverse()]);
    }
  }, [photos]);
  const current = queue[0] ?? null;
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => setQueue((q) => q.slice(1)), JUST_IN_MS);
    return () => clearTimeout(t);
  }, [current?.id]);

  if (config.paused) {
    return (
      <TvFrame>
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

  return (
    <TvFrame>
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
            <Spotlight photos={photos} showNames={config.showNames} />
          ) : config.layout === 'slideshow' ? (
            <Slideshow photos={photos} showNames={config.showNames} jumpTo={current?.id ?? null} />
          ) : (
            <Wall photos={photos} showNames={config.showNames} />
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

        {(config.showQr || phase === 'album' || phase === 'expired') && photos.length > 0 && (
          <aside className="w-[30vmin] shrink-0 flex flex-col gap-[2vmin]">
            {(phase === 'album' || phase === 'expired') && (
              <div className="rounded-[1.6vmin] bg-g2-panel border border-g2-blue/40 p-[2.4vmin]">
                <p className="font-expanded font-black text-[3vmin] text-white">That's a wrap.</p>
                <p className="mt-[0.8vmin] text-[2vmin] leading-snug text-g2-secondary">
                  {event.expireAt ? `The album is open until ${formatDay(event.expireAt.toMillis())}.` : 'Thanks for coming.'}
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
    </span>
  );
}

// Newest photo gets the biggest tile.
const WALL_SPANS = [
  'col-span-2 row-span-2', 'col-span-1 row-span-1', 'col-span-2 row-span-1', 'col-span-1 row-span-2',
  'col-span-2 row-span-2', 'col-span-1 row-span-1', 'col-span-1 row-span-1', 'col-span-1 row-span-1', 'col-span-2 row-span-1',
];

function Wall({ photos, showNames }: { photos: Photo[]; showNames: boolean }) {
  // 9+ photos: the full mosaic. 5–8: the newest big plus four. Fewer: an even grid.
  const tiles = photos.length >= WALL_SPANS.length ? photos.slice(0, WALL_SPANS.length) : photos.slice(0, photos.length >= 5 ? 5 : 4);
  if (tiles.length === 5) {
    return (
      <div className="absolute inset-0 grid grid-cols-4 grid-rows-2 gap-[1.2vmin]">
        {tiles.map((p, i) => (
          <div key={p.id} className={`relative rounded-[1.2vmin] overflow-hidden bg-black/40 ${i === 0 ? 'col-span-2 row-span-2' : ''}`}>
            <img src={p.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
            <Caption photo={p} showNames={showNames} size={i === 0 ? 'md' : 'sm'} />
          </div>
        ))}
      </div>
    );
  }
  if (tiles.length < 5) {
    return (
      <div className={`absolute inset-0 grid gap-[1.4vmin] ${tiles.length === 1 ? 'grid-cols-1' : 'grid-cols-2'} ${tiles.length > 2 ? 'grid-rows-2' : 'grid-rows-1'}`}>
        {tiles.map((p) => (
          <div key={p.id} className="relative rounded-[1.4vmin] overflow-hidden bg-black/40">
            <img src={p.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
            <Caption photo={p} showNames={showNames} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="absolute inset-0 grid grid-cols-6 grid-rows-3 gap-[1.2vmin] grid-flow-dense">
      {tiles.map((p, i) => (
        <div key={p.id} className={`relative rounded-[1.2vmin] overflow-hidden bg-black/40 ${WALL_SPANS[i]}`}>
          <img src={p.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
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
              <img src={p.url} alt="" className="absolute inset-0 w-full h-full object-cover" />
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

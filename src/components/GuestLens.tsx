import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Camera, Check, Users } from 'lucide-react';
import { addDoc, onSnapshot } from 'firebase/firestore';
import { useEvent } from '../EventContext';
import { eventPhase, expiryOf, paths } from '../events';
import { compressPhoto, uploadPhotoAsset } from '../firebase';
import { groupShotClock } from '../groupShot';
import {
  ASK_TIMEOUT_MS, FRAME_EVERY_MS, FRAME_LOST_MS, FRAME_STALE_MS, HEARTBEAT_MS, IDLE_END_MS, PRESENT_MS,
  LensEndReason, LensRequest, askCamera, askerEnd, checkIn, checkOut, endedMessage, fireShot,
  fireTimeOnThisPhone, lensCredit, millis, ownerAccept, ownerDecline, ownerEnd, ownerFrame, ownerShotDone,
} from '../guestLens';
import CloseButton from './CloseButton';
import { useBackToClose } from '../useBackToClose';

interface GuestLensProps {
  sessionId: string;
  nickname: string;
  /** The Borrow sheet is open (the gallery's Borrow button). */
  pickerOpen: boolean;
  onClosePicker: () => void;
  /** This phone is already sharing its camera with the host; don't stack another request on it. */
  busyElsewhere: boolean;
}

/** Guests borrowing each other's cameras: both sides. Renders nothing unless the host turned it on. */
export default function GuestLens(props: GuestLensProps) {
  const { event } = useEvent();
  const on = !!event.lensSharing && eventPhase(event) === 'live';
  if (!on) return null;
  return <GuestLensOn {...props} />;
}

function useNow(every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

function GuestLensOn({ sessionId, nickname, pickerOpen, onClosePicker, busyElsewhere }: GuestLensProps) {
  const { event } = useEvent();
  const eid = event.id;

  // Check in so other guests can find this phone in their Borrow list.
  useEffect(() => {
    if (!sessionId || !nickname) return;
    const go = () => checkIn(eid, sessionId, nickname, expiryOf(event)).catch((e) => console.warn('Check-in failed:', e));
    go();
    const t = setInterval(go, HEARTBEAT_MS);
    return () => {
      clearInterval(t);
      checkOut(eid, sessionId).catch(() => {});
    };
  }, [eid, sessionId, nickname]);

  // The person this phone asked (one at a time).
  const [asking, setAsking] = useState<{ uid: string; name: string } | null>(null);

  return (
    <>
      <OwnerSide sessionId={sessionId} busyElsewhere={busyElsewhere || !!asking} />
      <AnimatePresence>
        {pickerOpen && !asking && (
          <Picker
            key="picker"
            sessionId={sessionId}
            onPick={(p) => { onClosePicker(); setAsking(p); }}
            onClose={onClosePicker}
          />
        )}
      </AnimatePresence>
      {asking && (
        <AskerSide
          sessionId={sessionId}
          nickname={nickname}
          owner={asking}
          onDone={() => setAsking(null)}
        />
      )}
    </>
  );
}

// ---------- Picking who to ask ----------

function Picker({ sessionId, onPick, onClose }: {
  key?: string;
  sessionId: string;
  onPick: (p: { uid: string; name: string }) => void;
  onClose: () => void;
}) {
  const { event } = useEvent();
  const [people, setPeople] = useState<{ uid: string; name: string; seen: number }[] | null>(null);
  const now = useNow(15_000);
  useBackToClose(true, onClose);

  useEffect(() => onSnapshot(
    paths.people(event.id),
    (snap) => setPeople(snap.docs.map((d) => ({
      uid: d.id,
      name: String((d.data() as any).nickname || 'guest'),
      seen: millis((d.data() as any).lastSeen) || Date.now(),
    }))),
    () => setPeople([])
  ), [event.id]);

  const here = (people || [])
    .filter((p) => p.uid !== sessionId && now - p.seen < PRESENT_MS)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-g2-page/75 flex items-end justify-center font-sans"
      onClick={onClose}
    >
      <motion.section
        role="dialog"
        aria-modal="true"
        aria-labelledby="borrow-title"
        initial={{ y: 40 }}
        animate={{ y: 0 }}
        exit={{ y: 40 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[85dvh] bg-g2-panel border-t border-white/10 rounded-t-[20px] px-5 pt-3 pb-7 flex flex-col gap-4"
      >
        <div className="w-10 h-1 rounded-full bg-white/15 self-center" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">Borrow a camera</p>
            <h2 id="borrow-title" className="mt-0.5 font-expanded font-black text-[22px] leading-tight text-white">
              Whose camera?
            </h2>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <p className="text-sm leading-relaxed text-g2-secondary">
          They get a request. If they say yes, you see their camera and take the shot, so you can be in it.
        </p>
        <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 flex flex-col gap-2">
          {people === null ? (
            <p className="text-sm text-g2-tertiary py-4 text-center">Looking for people…</p>
          ) : here.length === 0 ? (
            <p className="text-sm text-g2-tertiary py-4 text-center">
              Nobody else is here yet. People show up once they open the gallery.
            </p>
          ) : (
            here.map((p) => (
              <button
                key={p.uid}
                type="button"
                onClick={() => onPick({ uid: p.uid, name: p.name })}
                className="h-14 px-4 rounded-xl bg-black/40 border border-white/[0.08] hover:border-g2-blue/60 flex items-center justify-between gap-3 cursor-pointer text-left"
              >
                <span className="flex items-center gap-3 min-w-0">
                  <span className="w-9 h-9 rounded-full bg-white/10 flex items-center justify-center font-bold text-white shrink-0" aria-hidden="true">
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="font-semibold text-white truncate">{p.name}</span>
                </span>
                <span className="shrink-0 h-9 px-4 inline-flex items-center rounded-full bg-g2-blue text-white text-[13px] font-bold">Ask</span>
              </button>
            ))
          )}
        </div>
      </motion.section>
    </motion.div>
  );
}

// ---------- The person asking ----------

function AskerSide({ sessionId, nickname, owner, onDone }: {
  sessionId: string;
  nickname: string;
  owner: { uid: string; name: string };
  onDone: () => void;
}) {
  const { event } = useEvent();
  const eid = event.id;
  const [req, setReq] = useState<LensRequest | null>(null);
  const [problem, setProblem] = useState('');
  const [sent, setSent] = useState(false);
  const [askedAt] = useState(Date.now());
  const [shot, setShot] = useState<{ id: string; at: number } | null>(null);
  const [liveAt, setLiveAt] = useState(0);
  const endedRef = useRef(false);
  const askedRef = useRef(false);
  const now = useNow(250);

  // Send the request, once (asking twice would look like someone else holding the camera).
  useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    askCamera(eid, { uid: sessionId, name: nickname }, owner, expiryOf(event))
      .then(() => setSent(true))
      .catch(() => {
        // The rules say no: someone else has the camera, they just said no to us, or they left.
        setProblem(`${owner.name}'s camera isn't free right now. Try again in a minute.`);
      });
  }, []);

  // Follow it.
  useEffect(() => {
    if (!sent) return;
    return onSnapshot(
      paths.lensRequest(eid, owner.uid),
      (snap) => {
        const d = snap.exists() ? (snap.data() as LensRequest) : null;
        if (!d || d.from !== sessionId) { setProblem(`${owner.name}'s camera isn't free right now.`); return; }
        setReq(d);
      },
      () => setProblem(`${owner.name}'s camera isn't free right now.`)
    );
  }, [sent]);

  const status = req?.status;
  useEffect(() => { if (status === 'live' && !liveAt) setLiveAt(Date.now()); }, [status]);

  const end = useCallback((reason: LensEndReason) => {
    if (endedRef.current) return;
    endedRef.current = true;
    askerEnd(eid, owner.uid, reason).catch(() => {});
  }, [eid, owner.uid]);

  // Timeouts: no answer, or the camera went quiet.
  const frameAge = req?.frameAt ? now - millis(req.frameAt) : liveAt ? now - liveAt : 0;
  useEffect(() => {
    if (status === 'asking' && now - askedAt > ASK_TIMEOUT_MS) {
      end('noanswer');
      setProblem(endedMessage('noanswer', owner.name));
    }
    if (status === 'live' && frameAge > FRAME_LOST_MS) {
      end('lost');
      setProblem(endedMessage('lost', owner.name));
    }
  }, [now]);

  const close = () => {
    if (status === 'asking') end('cancelled');
    else if (status === 'live') end('closed');
    onDone();
  };
  useBackToClose(true, close);

  const takeIt = async () => {
    if (shot && now < shot.at + 6_000 && req?.lastShotId !== shot.id) return; // one at a time
    try {
      const s = await fireShot(eid, owner.uid);
      setShot({ id: s.id, at: millis(s.firesAt) });
    } catch {
      setProblem(`Couldn't reach ${owner.name}'s camera.`);
    }
  };

  const shotDone = !!shot && req?.lastShotId === shot.id;
  const countdown = shot && !shotDone && now < shot.at ? Math.ceil((shot.at - now) / 1000) : null;
  const waitingForPhoto = shot && !shotDone && now >= shot.at && now < shot.at + 20_000;
  const shotStuck = shot && !shotDone && now >= shot.at + 20_000;
  const reviewNote = event.autoApproval ? 'It’s in the gallery and in your photos.' : 'Sent to the host for review. You’ll find it in Mine.';

  // Something's wrong, or it's over: a small sheet with the reason.
  const endedText = problem
    || (status === 'declined' ? `${owner.name} said not now.` : '')
    || (status === 'ended' && !endedRef.current ? endedMessage(req?.endReason, owner.name) : '');

  if (endedText) {
    return (
      <Sheet title={status === 'declined' ? 'Not this time' : !sent ? 'Not available' : 'Camera closed'} onClose={onDone}>
        <p className="text-sm leading-relaxed text-g2-secondary">{endedText}</p>
        <button onClick={onDone} className="h-[52px] rounded-lg bg-g2-blue hover:bg-g2-blue-hover text-white font-bold text-[15px] cursor-pointer">
          OK
        </button>
      </Sheet>
    );
  }

  if (status !== 'live') {
    return (
      <Sheet title={`Asking ${owner.name}…`} onClose={close}>
        <p className="text-sm leading-relaxed text-g2-secondary">
          {owner.name} gets a request on their phone. When they say yes, their camera opens here.
        </p>
        <div className="h-2 rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
          <div
            className="h-full bg-g2-blue transition-[width] duration-300"
            style={{ width: `${Math.min(100, ((now - askedAt) / ASK_TIMEOUT_MS) * 100)}%` }}
          />
        </div>
        <button onClick={close} className="h-[52px] rounded-lg border border-white/10 text-g2-secondary hover:text-white font-semibold text-[15px] cursor-pointer">
          Cancel
        </button>
      </Sheet>
    );
  }

  const paused = frameAge > FRAME_STALE_MS;
  return (
    <div className="fixed inset-0 bg-black z-50 font-sans" role="dialog" aria-modal="true" aria-label={`${owner.name}'s camera`}>
      <div className="absolute inset-0 flex items-center justify-center">
        {req?.frame ? (
          <img src={req.frame} alt={`Live view from ${owner.name}'s camera`} className="w-full h-full object-contain" />
        ) : (
          <p className="text-sm text-g2-tertiary">Opening {owner.name}'s camera…</p>
        )}
      </div>

      <header className="absolute top-0 inset-x-0 pt-4 pl-5 pr-4 flex justify-between items-center z-10">
        <div className="h-8 px-3 flex items-center gap-2 rounded-full bg-g2-page/85 border border-white/15 font-mono text-[10.5px] font-bold tracking-[0.06em] uppercase text-white">
          <Users className="w-3.5 h-3.5" aria-hidden="true" /> {owner.name}'s camera
        </div>
        <CloseButton onClick={close} label="Close the camera" className="bg-black/60 hover:bg-black/80" />
      </header>

      {paused && !countdown && (
        <div className="absolute inset-x-6 top-20 z-10 rounded-xl bg-g2-page/90 border border-amber-300/40 px-4 py-3 text-[13px] text-amber-100">
          {owner.name}'s camera is paused. Their phone may be locked.
        </div>
      )}

      {countdown !== null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 z-10" aria-live="assertive">
          <p className="font-condensed font-extrabold text-[13px] tracking-[0.16em] uppercase text-white">Get in the shot</p>
          <div className="w-[168px] h-[168px] rounded-full border-4 border-white bg-g2-page/55 flex items-center justify-center">
            <span className="font-expanded font-black text-8xl leading-none text-white">{countdown}</span>
          </div>
        </div>
      )}

      <footer className="absolute bottom-0 inset-x-0 px-5 pt-5 pb-8 bg-g2-page/90 border-t border-white/[0.08] flex flex-col items-center gap-3 z-10">
        <p className="text-center text-[14px] leading-normal text-g2-text min-h-[42px]" aria-live="polite">
          {shotDone
            ? `Got it! ${reviewNote}`
            : waitingForPhoto
              ? 'Taking it…'
              : shotStuck
                ? "That one didn't come through. Try again."
                : `Frame it here, tap the shutter, then get in the picture. ${owner.name} holds the phone.`}
        </p>
        <button
          onClick={takeIt}
          disabled={countdown !== null || !!waitingForPhoto || paused}
          aria-label="Take the photo"
          className="w-[76px] h-[76px] rounded-full border-[3px] border-white p-[5px] active:scale-95 transition-transform disabled:opacity-40 cursor-pointer"
        >
          <span className="flex w-full h-full rounded-full bg-white items-center justify-center text-g2-page">
            <Camera className="w-[26px] h-[26px]" aria-hidden="true" />
          </span>
        </button>
      </footer>
    </div>
  );
}

// ---------- The camera owner ----------

function OwnerSide({ sessionId, busyElsewhere }: { sessionId: string; busyElsewhere: boolean }) {
  const { event } = useEvent();
  const eid = event.id;
  const [req, setReq] = useState<LensRequest | null>(null);
  const now = useNow(1000);

  useEffect(() => onSnapshot(
    paths.lensRequest(eid, sessionId),
    (snap) => setReq(snap.exists() ? (snap.data() as LensRequest) : null),
    () => setReq(null)
  ), [eid, sessionId]);

  const groupShotOn = groupShotClock(event.groupShot ?? null, now) !== null;
  const askedFresh = req?.status === 'asking' && now - millis(req.updatedAt) < ASK_TIMEOUT_MS;
  const showAsk = askedFresh && !busyElsewhere && !groupShotOn;
  const live = req?.status === 'live';

  const [opening, setOpening] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);

  const decline = () => { ownerDecline(eid, sessionId).catch(() => {}); };
  const accept = async () => {
    setOpening(true);
    try {
      streamRef.current = await openCamera();
      await ownerAccept(eid, sessionId);
    } catch (e) {
      console.error('Lending the camera failed:', e);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      ownerEnd(eid, sessionId, 'camera').catch(() => {});
    } finally {
      setOpening(false);
    }
  };
  useBackToClose(!!showAsk, decline);

  return (
    <>
      <AnimatePresence>
        {showAsk && req && (
          <motion.div
            key="lens-ask"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-g2-page/75 flex items-end justify-center font-sans"
          >
            <motion.section
              role="dialog"
              aria-modal="true"
              aria-labelledby="lend-title"
              initial={{ y: 40 }}
              animate={{ y: 0 }}
              exit={{ y: 40 }}
              className="w-full max-w-md bg-g2-panel border-t border-white/10 rounded-t-[20px] px-5 pt-3 pb-7 flex flex-col gap-4"
            >
              <div className="w-10 h-1 rounded-full bg-white/15 self-center" />
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-g2-blue text-white flex items-center justify-center shrink-0">
                  <Users className="w-6 h-6" aria-hidden="true" />
                </div>
                <div>
                  <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">Camera request</p>
                  <h2 id="lend-title" className="mt-0.5 font-expanded font-black text-[22px] leading-tight text-white">
                    {req.fromName} wants to use your camera
                  </h2>
                </div>
              </div>
              <p className="text-sm leading-relaxed text-g2-secondary">
                Point your phone at them. They frame it and take the picture, so they can be in it.
              </p>
              <ul className="flex flex-col gap-2.5">
                {[
                  `${req.fromName} sees your camera only while you're sharing.`,
                  'A countdown before every shot. Stop anytime.',
                ].map((line) => (
                  <li key={line} className="flex gap-2.5 items-start text-[13px] leading-normal text-g2-text">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
                    {line}
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-2 mt-1">
                <button
                  onClick={accept}
                  disabled={opening}
                  className="h-[52px] rounded-lg bg-g2-blue hover:bg-g2-blue-hover disabled:opacity-60 text-white font-bold text-[15px] cursor-pointer transition-colors"
                >
                  {opening ? 'Opening your camera…' : 'Share my camera'}
                </button>
                <button
                  onClick={decline}
                  disabled={opening}
                  className="h-[52px] rounded-lg border border-white/10 text-g2-secondary hover:text-white font-semibold text-[15px] cursor-pointer transition-colors"
                >
                  Not now
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      {live && req && (
        <OwnerCamera
          req={req}
          sessionId={sessionId}
          streamRef={streamRef}
          groupShotOn={groupShotOn}
        />
      )}
    </>
  );
}

async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('No camera API');
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}

function OwnerCamera({ req, sessionId, streamRef, groupShotOn }: {
  req: LensRequest;
  sessionId: string;
  streamRef: React.MutableRefObject<MediaStream | null>;
  groupShotOn: boolean;
}) {
  const { event, isEventHost } = useEvent();
  const eid = event.id;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const endedRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const handledShotRef = useRef<string | null>(req.lastShotId ?? null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [note, setNote] = useState('');

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  const end = useCallback((reason: LensEndReason) => {
    if (endedRef.current) return;
    endedRef.current = true;
    ownerEnd(eid, sessionId, reason).catch(() => {});
  }, [eid, sessionId]);

  // Camera on (re-open if this screen came back without one, e.g. after a reload).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!streamRef.current) streamRef.current = await openCamera();
        if (cancelled) return;
        const v = videoRef.current;
        if (v) { v.srcObject = streamRef.current; v.play().catch(() => {}); }
      } catch {
        end('camera');
      }
    })();
    return () => { cancelled = true; stopCamera(); };
  }, []);

  // Small preview frames for the person asking.
  useEffect(() => {
    const canvas = document.createElement('canvas');
    const t = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.videoWidth || endedRef.current) return;
      const w = 240;
      canvas.width = w;
      canvas.height = Math.round((w * v.videoHeight) / v.videoWidth);
      canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height);
      ownerFrame(eid, sessionId, canvas.toDataURL('image/jpeg', 0.5)).catch(() => {});
    }, FRAME_EVERY_MS);
    return () => clearInterval(t);
  }, []);

  // A Group Shot goes first; a locked phone or a quiet camera ends it.
  useEffect(() => { if (groupShotOn) end('groupshot'); }, [groupShotOn]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') end('away'); };
    document.addEventListener('visibilitychange', onHide);
    const idle = setInterval(() => {
      if (Date.now() - lastActivityRef.current > IDLE_END_MS) end('idle');
    }, 5_000);
    return () => { document.removeEventListener('visibilitychange', onHide); clearInterval(idle); };
  }, []);

  // The asker fired: count down to the shared moment, then take it.
  const shot = req.shot;
  useEffect(() => {
    // handledShotRef is set when the photo is taken, so a re-run of this effect
    // (React may run it twice) restarts the same countdown instead of dropping it.
    if (!shot || handledShotRef.current === shot.id) return;
    lastActivityRef.current = Date.now();
    const at = fireTimeOnThisPhone(shot);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const tick = () => {
      const left = at - Date.now();
      if (left > 0) {
        setCountdown(Math.ceil(left / 1000));
        timers.push(setTimeout(tick, Math.min(250, left)));
        return;
      }
      setCountdown(null);
      if (handledShotRef.current === shot.id) return;
      handledShotRef.current = shot.id;
      capture(shot.id);
    };
    tick();
    return () => timers.forEach(clearTimeout);
  }, [shot?.id]);

  const capture = async (shotId: string) => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) { setNote("The camera wasn't ready. Ask them to try again."); return; }
    setFlash(true);
    setTimeout(() => setFlash(false), 450);
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) return;
    try {
      setNote('Sending it to the gallery…');
      const name = `borrowed_${Date.now()}.jpg`;
      const compressed = await compressPhoto(new File([blob], name, { type: 'image/jpeg' }));
      const url = await uploadPhotoAsset(compressed, name, eid);
      const approved = event.autoApproval || isEventHost;
      await addDoc(paths.photos(eid), {
        url,
        nickname: lensCredit(req.fromName, req.toName),
        sessionId,
        createdAt: Date.now(),
        status: approved ? 'approved' : 'pending',
        reactions: { likes: 0, dislikes: 0 },
        flagged: false,
        takenBy: { uid: req.from, nickname: req.fromName },
        ...expiryOf(event),
      });
      await ownerShotDone(eid, sessionId, shotId);
      setNote(approved ? 'Got it! It’s in the gallery.' : 'Got it! Sent to the host for review.');
    } catch (e) {
      console.error('Borrowed-camera photo failed:', e);
      setNote("That photo didn't upload. They can take another.");
    }
    lastActivityRef.current = Date.now();
  };

  const stop = () => end('stopped');
  useBackToClose(true, stop);

  return (
    <div className="fixed inset-0 bg-black z-50 font-sans" role="dialog" aria-modal="true" aria-label="Sharing your camera">
      <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover" />

      <header className="absolute top-0 inset-x-0 pt-4 pl-5 pr-4 flex justify-between items-center z-10">
        <div className="h-8 max-w-[75%] px-3 flex items-center gap-2 rounded-full bg-g2-page/85 border border-g2-live font-mono text-[10.5px] font-bold tracking-[0.06em] uppercase text-red-300">
          <span className="w-2 h-2 rounded-full bg-g2-live animate-pulse shrink-0" />
          <span className="truncate">Live · {req.fromName} can see this</span>
        </div>
        <CloseButton onClick={stop} label="Stop sharing" className="bg-black/60 hover:bg-black/80" />
      </header>

      {countdown !== null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 z-10" aria-live="assertive">
          <p className="font-condensed font-extrabold text-[13px] tracking-[0.16em] uppercase text-white">Hold steady</p>
          <div className="w-[168px] h-[168px] rounded-full border-4 border-white bg-g2-page/55 flex items-center justify-center">
            <span className="font-expanded font-black text-8xl leading-none text-white">{countdown}</span>
          </div>
        </div>
      )}

      {flash && (
        <div className="absolute inset-0 bg-white flex items-center justify-center z-20">
          <span className="font-expanded font-black text-3xl text-g2-page">Got it!</span>
        </div>
      )}

      <footer className="absolute bottom-0 inset-x-0 px-5 pt-5 pb-8 bg-g2-page/90 border-t border-white/[0.08] flex flex-col gap-3.5 z-10">
        <p className="text-center text-[15px] leading-normal text-g2-text" aria-live="polite">
          {note || `Point your phone at ${req.fromName}. They take the shot.`}
        </p>
        <button
          onClick={stop}
          className="h-[52px] rounded-lg border border-white/15 text-white font-semibold text-[15px] cursor-pointer"
        >
          Stop sharing
        </button>
      </footer>
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-g2-page/75 flex items-end justify-center font-sans" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-g2-panel border-t border-white/10 rounded-t-[20px] px-5 pt-3 pb-7 flex flex-col gap-4"
      >
        <div className="w-10 h-1 rounded-full bg-white/15 self-center" />
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-expanded font-black text-[22px] leading-tight text-white">{title}</h2>
          <CloseButton onClick={onClose} />
        </div>
        {children}
      </section>
    </div>
  );
}

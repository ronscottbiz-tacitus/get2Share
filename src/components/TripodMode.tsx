import React, { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, X, ShieldAlert, Battery } from 'lucide-react';
import { doc, setDoc, deleteDoc, onSnapshot, updateDoc, addDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { eventPhase, expiryOf, paths } from '../events';
import { normalizePairingCode, formatPairingCode, STORED_SPOT_CODE_KEY } from '../spotPairing';
import { BACKGROUND_MS, FOCUS_MS, FRAME, NORMAL_MS, WATCH_TIMEOUT_MS } from '../liveConsole';
import { db, compressPhoto, uploadPhotoAsset, handleFirestoreError, OperationType } from '../firebase';
import { motion } from 'motion/react';
import FullscreenButton from './FullscreenButton';
import CloseButton from './CloseButton';
import SpotTapLayer, { SpotPhase } from './SpotTapLayer';

const COUNTDOWN_FROM = 5;
const SHOW_PHOTO_SECONDS = 25;

interface TripodModeProps {
  onExit: () => void;
  sessionId: string;
}

export default function TripodMode({ onExit, sessionId }: TripodModeProps) {
  const [tripodName, setTripodName] = useState('');
  // The event this Share Spot belongs to (learned from its pairing code).
  const [eventId, setEventId] = useState<string | null>(null);
  const eventIdRef = useRef<string | null>(null);
  const sessionRef = () => paths.session(eventIdRef.current as string, sessionId);
  // The event's end and cleanup dates, so photos and this spot expire with the album.
  const eventTimesRef = useRef<{ endsAt?: any; expireAt?: any } | null>(null);
  // Host-issued pairing code. Remembered so this device can reconnect after a reload.
  const [pairingCode, setPairingCode] = useState(() => {
    try { return localStorage.getItem(STORED_SPOT_CODE_KEY) || ''; } catch { return ''; }
  });
  const [connecting, setConnecting] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [error, setError] = useState('');
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null); // null = browser doesn't say
  const [charging, setCharging] = useState<boolean | null>(null);
  // What the Host Console wants from us: no previews, normal, or fast (focused).
  const [previewMode, setPreviewMode] = useState<'off' | 'normal' | 'focus' | 'background'>('off');
  const previewModeRef = useRef<'off' | 'normal' | 'focus' | 'background'>('off');
  // Front camera by default so guests can see themselves on the Share Spot's screen.
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [, setCapturing] = useState(false);
  // The guest-facing tap flow: idle → countdown → saving → captured (scan to keep).
  const [spotPhase, setSpotPhase] = useState<SpotPhase>('idle');
  const spotPhaseRef = useRef<SpotPhase>('idle');
  const [count, setCount] = useState(COUNTDOWN_FROM);
  const [lastPhoto, setLastPhoto] = useState<{ id: string; url: string } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(SHOW_PHOTO_SECONDS);
  const flowTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [joinCode, setJoinCode] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Refs (not state) so timers and listeners always see the current values.
  const registeredRef = useRef(false);
  const capturingRef = useRef(false);

  // Open a camera, falling back gracefully on older devices that reject strict requests.
  const openCamera = async (facing: 'user' | 'environment') => {
    const attempts: MediaStreamConstraints[] = [
      { video: { facingMode: { exact: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: facing }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr: unknown;
    for (const c of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(c);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };

  const attachStream = (stream: MediaStream) => {
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => {});
    }
  };

  // Stop the camera and preview frames without removing this Share Spot.
  const stopCamera = () => {
    if (frameTimerRef.current) {
      clearTimeout(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  // Callback ref to bind stream as soon as video element is mounted in DOM
  const setVideoRef = (node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      node.play().catch((err) => {
        console.error("Error starting tripod video playback:", err);
      });
    }
  };

  // Battery level and charging, where the browser supports it (Android Chrome does; iPhone/iPad don't).
  useEffect(() => {
    if (!('getBattery' in navigator)) return;
    (navigator as any).getBattery().then((battery: any) => {
      const read = () => {
        setBatteryLevel(Math.round(battery.level * 100));
        setCharging(!!battery.charging);
      };
      read();
      battery.addEventListener('levelchange', read);
      battery.addEventListener('chargingchange', read);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isRegistered || !sessionId) return;
    updateDoc(sessionRef(), {
      'deviceInfo.batteryLevel': batteryLevel,
      'deviceInfo.charging': charging,
    }).catch((err) => {
      handleFirestoreError(err, OperationType.UPDATE, `sessions/${sessionId}`);
    });
  }, [batteryLevel, charging, isRegistered, sessionId]);

  // When the event ends, this Share Spot switches itself off.
  useEffect(() => {
    if (!isRegistered || !eventIdRef.current) return;
    const check = (data: any) => {
      eventTimesRef.current = data ? { endsAt: data.endsAt, expireAt: data.expireAt } : null;
      if (data?.joinCode) setJoinCode(data.joinCode);
      if (data && eventPhase(data) !== 'live' && registeredRef.current) {
        cleanupStream();
        setIsRegistered(false);
        setError('This event has ended, so the Share Spot is off. Thanks for helping everyone get in the picture!');
      }
    };
    let latest: any = null;
    const unsub = onSnapshot(paths.event(eventIdRef.current), (snap) => {
      latest = snap.exists() ? snap.data() : null;
      check(latest);
    }, () => {});
    const t = setInterval(() => check(latest), 30000);
    return () => { unsub(); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRegistered]);

  // Listen for the Host Console. Only send previews while someone is watching.
  // "Watching" is judged by when the last heartbeat *arrived* on this device,
  // so a tablet with the wrong clock still behaves.
  useEffect(() => {
    if (!isRegistered || !sessionId) return;
    let lastBeatAt = 0;
    let latest: { watching?: boolean; focusSpot?: string | null } = {};
    const apply = () => {
      const alive = latest.watching === true && Date.now() - lastBeatAt < WATCH_TIMEOUT_MS;
      const mode = !alive ? 'off' : !latest.focusSpot ? 'normal' : latest.focusSpot === sessionId ? 'focus' : 'background';
      if (mode !== previewModeRef.current) {
        previewModeRef.current = mode;
        setPreviewMode(mode);
        if (mode !== 'off') sendFrameSoon();
      }
    };
    const unsub = onSnapshot(
      paths.console(eventIdRef.current as string),
      (snap) => {
        latest = snap.exists() ? (snap.data() as any) : {};
        lastBeatAt = Date.now();
        apply();
      },
      () => {
        latest = {};
        apply();
      }
    );
    const t = setInterval(apply, 5000);
    return () => {
      unsub();
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRegistered, sessionId]);

  // Handle stream cleanup
  useEffect(() => {
    return () => {
      clearFlowTimers();
      cleanupStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen to remote trigger command from the Host
  useEffect(() => {
    if (!isRegistered || !sessionId) return;

    const docRef = sessionRef();
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (!snap.exists()) {
        // The host removed this Share Spot from the Host Console.
        if (registeredRef.current) {
          registeredRef.current = false;
          stopCamera();
          setIsRegistered(false);
          try { localStorage.removeItem(STORED_SPOT_CODE_KEY); } catch { /* ignore */ }
          setPairingCode('');
          setError('The host removed this Share Spot. Ask them for a new code to set it up again.');
        }
        return;
      }
      {
        const data = snap.data();
        if (data.trigger_shutter === true) {
          runCapture(true);
          // Reset the trigger
          updateDoc(docRef, { trigger_shutter: false }).catch((err) => {
            handleFirestoreError(err, OperationType.UPDATE, `sessions/${sessionId}`);
          });
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [isRegistered, sessionId]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = normalizePairingCode(pairingCode);
    if (code.length !== 6) {
      setError('Enter the 6-character code from the Host Console.');
      return;
    }
    setError('');
    setConnecting(true);

    try {
      // 1. Claim the code (or confirm this device already claimed it earlier).
      const pairingRef = doc(db, 'spotPairings', code);
      let spotName = '';
      let spotEventId = '';
      let spotExpireAt: any = null;
      try {
        const existing = await getDoc(pairingRef); // only readable once it's ours
        if (existing.exists() && existing.data().claimedBy === sessionId) {
          spotName = existing.data().spotName;
          spotEventId = existing.data().eventId;
          spotExpireAt = existing.data().expireAt ?? null;
        }
      } catch {
        // Not ours yet: claim it below.
      }
      if (!spotName) {
        try {
          await updateDoc(pairingRef, { claimedBy: sessionId, claimedAt: serverTimestamp() });
          const claimed = await getDoc(pairingRef);
          spotName = claimed.data()?.spotName || '';
          spotEventId = claimed.data()?.eventId || '';
          spotExpireAt = claimed.data()?.expireAt ?? null;
        } catch (err) {
          console.error('Pairing failed:', err);
          setError("That code didn't work. Codes work once and expire after 10 minutes, so ask the host for a new one.");
          return;
        }
      }
      if (!spotEventId) {
        setError("That code isn't linked to an event. Ask the host for a new one.");
        return;
      }
      try { localStorage.setItem(STORED_SPOT_CODE_KEY, code); } catch { /* ignore */ }
      setTripodName(spotName);
      eventIdRef.current = spotEventId;
      setEventId(spotEventId);

      // Join the event as a Share Spot (the database checks the pairing code).
      let eventData: any = null;
      try {
        const memberRef = paths.member(spotEventId, sessionId);
        const already = await getDoc(memberRef).then((m) => m.exists()).catch(() => false);
        if (!already) {
          await setDoc(memberRef, {
            nickname: spotName, joinedAt: serverTimestamp(), joinCode: code, role: 'spot',
            ...(spotExpireAt ? { expireAt: spotExpireAt } : {}),
          });
        }
        eventData = await getDoc(paths.event(spotEventId)).then((d) => (d.exists() ? d.data() : null)).catch(() => null);
        eventTimesRef.current = eventData ? { endsAt: eventData.endsAt, expireAt: eventData.expireAt } : null;
        if (eventData?.joinCode) setJoinCode(eventData.joinCode);
        if (eventData && eventPhase(eventData) !== 'live') {
          setError('This event has already ended, so it can\'t take Share Spots any more.');
          return;
        }
      } catch (err) {
        console.error('Share Spot join failed:', err);
        setError("Couldn't connect this Share Spot. Ask the host for a new code.");
        return;
      }

      // 2. Open the camera (front by default).
      try {
        attachStream(await openCamera(facingMode));
      } catch (err) {
        console.error(err);
        setError("Couldn't open the camera. Allow camera access for this site and try again.");
        return;
      }

      // 3. Register as a Share Spot. The database checks the pairing code.
      try {
        await setDoc(sessionRef(), {
          sessionId: sessionId,
          nickname: spotName,
          role: 'tripod',
          pairing_code: code,
          lastActive: Date.now(),
          deviceInfo: {
            batteryLevel,
            charging,
            userAgent: navigator.userAgent,
            deviceName: `${spotName} Lens`,
          },
          lens_status: 'streaming',
          ...expiryOf(eventTimesRef.current),
          invited_to_lens: false,
          trigger_shutter: false,
        }, { merge: true });
      } catch (err) {
        console.error('Share Spot registration failed:', err);
        stopCamera();
        setError("Couldn't connect this Share Spot. Ask the host for a new code.");
        return;
      }

      registeredRef.current = true;
      setIsRegistered(true);
      startFrameStreaming();
    } finally {
      setConnecting(false);
    }
  };

  // Preview frames for the Host Console. The loop re-reads previewModeRef each
  // time, so speed changes (off / normal / focused) take effect right away.
  const frameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameInFlightRef = useRef(false);

  const sendFrame = () => {
    const mode = previewModeRef.current;
    const video = videoRef.current;
    if (mode === 'off' || !video || !streamRef.current || !registeredRef.current) return;
    if (frameInFlightRef.current || !video.videoWidth) return; // slow network or camera not ready

    if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, quality } = mode === 'focus' ? FRAME.focus : FRAME.normal;
    canvas.width = width;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * width) || 180;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    frameInFlightRef.current = true;
    updateDoc(sessionRef(), {
      stream_frame: canvas.toDataURL('image/jpeg', quality),
      lastActive: Date.now(),
    })
      .catch((err) => handleFirestoreError(err, OperationType.UPDATE, `sessions/${sessionId}`))
      .finally(() => {
        frameInFlightRef.current = false;
      });
  };

  const scheduleNextFrame = () => {
    if (frameTimerRef.current) clearTimeout(frameTimerRef.current);
    const mode = previewModeRef.current;
    const delay = mode === 'focus' ? FOCUS_MS : mode === 'background' ? BACKGROUND_MS : NORMAL_MS;
    frameTimerRef.current = setTimeout(() => {
      sendFrame();
      if (registeredRef.current) scheduleNextFrame();
    }, delay);
  };

  // Send one right away (e.g. the host just opened the console or focused us).
  const sendFrameSoon = () => {
    setTimeout(sendFrame, 150);
    scheduleNextFrame();
  };

  const startFrameStreaming = () => {
    scheduleNextFrame();
  };

  // fromHost = the host fired the remote shutter (publishes immediately).
  // A guest's tap follows the event's normal approval setting.
  // Resolves with the new photo, or null if it couldn't be saved.
  const triggerShutterCapture = async (fromHost: boolean = false): Promise<{ id: string; url: string } | null> => {
    const video = videoRef.current;
    if (!video || capturingRef.current) return null;
    capturingRef.current = true;
    setCapturing(true);
    try {
      const captureCanvas = document.createElement('canvas');
      captureCanvas.width = video.videoWidth || 1920;
      captureCanvas.height = video.videoHeight || 1080;
      const ctx = captureCanvas.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');
      ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

      const blob = await new Promise<Blob | null>((resolve) => captureCanvas.toBlob(resolve, 'image/jpeg', 0.95));
      if (!blob) return null;

      const file = new File([blob], `tripod_${tripodName}_${Date.now()}.jpg`, { type: 'image/jpeg' });
      // Downscale and compress on the device (1200px wide, ~80% JPEG).
      const compressedBlob = await compressPhoto(file);
      const downloadUrl = await uploadPhotoAsset(compressedBlob, `tripod_${tripodName}_${Date.now()}.jpg`, eventIdRef.current as string);

      // Host-triggered captures publish immediately (the database verifies the
      // host fired the shutter in the last 2 minutes). Guest taps follow the
      // event's approval setting.
      let status: 'approved' | 'pending' = 'pending';
      if (fromHost) {
        status = 'approved';
      } else {
        try {
          const settingsSnap = await getDoc(paths.event(eventIdRef.current as string));
          if (settingsSnap.exists() && settingsSnap.data().autoApproval === true) status = 'approved';
        } catch {
          // keep 'pending'
        }
      }
      const ref = await addDoc(paths.photos(eventIdRef.current as string), {
        url: downloadUrl,
        nickname: `${tripodName} (Share Spot)`,
        sessionId: sessionId,
        createdAt: Date.now(),
        status,
        reactions: { likes: 0, dislikes: 0 },
        flagged: false,
        ...expiryOf(eventTimesRef.current),
      });
      return { id: ref.id, url: downloadUrl };
    } catch (err) {
      console.error('Share Spot capture failed:', err);
      return null;
    } finally {
      capturingRef.current = false;
      setCapturing(false);
    }
  };

  // ---------- The tap flow ----------
  const setPhase = (p: SpotPhase) => {
    spotPhaseRef.current = p;
    setSpotPhase(p);
  };
  const clearFlowTimers = () => {
    flowTimers.current.forEach(clearTimeout);
    flowTimers.current = [];
  };
  const later = (fn: () => void, ms: number) => {
    flowTimers.current.push(setTimeout(fn, ms));
  };

  // Take the photo, then show it with a code to keep it.
  const runCapture = async (fromHost: boolean) => {
    if (capturingRef.current) return;
    clearFlowTimers();
    setPhase('saving');
    const photo = await triggerShutterCapture(fromHost);
    if (!photo) {
      setPhase('failed');
      later(() => setPhase('idle'), 4000);
      return;
    }
    setLastPhoto(photo);
    setPhase('captured');
    for (let i = 0; i <= SHOW_PHOTO_SECONDS; i++) {
      later(() => {
        setSecondsLeft(SHOW_PHOTO_SECONDS - i);
        if (i === SHOW_PHOTO_SECONDS) setPhase('idle');
      }, i * 1000);
    }
  };

  // A guest tapped the screen: count down from 5, then shoot.
  const handleTap = () => {
    const phase = spotPhaseRef.current;
    if (phase === 'countdown' || phase === 'saving' || capturingRef.current) return;
    clearFlowTimers();
    setCount(COUNTDOWN_FROM);
    setPhase('countdown');
    for (let i = 1; i < COUNTDOWN_FROM; i++) later(() => setCount(COUNTDOWN_FROM - i), i * 1000);
    later(() => runCapture(false), COUNTDOWN_FROM * 1000);
  };

  const toggleFacingMode = async () => {
    const nextFacing = facingMode === 'environment' ? 'user' : 'environment';
    stopCamera();
    try {
      attachStream(await openCamera(nextFacing));
      setFacingMode(nextFacing);
    } catch (err) {
      console.error('Camera switch failed:', err);
      // Fall back to whichever camera works
      try {
        attachStream(await openCamera(facingMode));
      } catch {
        setError("Couldn't switch cameras on this device.");
      }
    }
    if (registeredRef.current) startFrameStreaming();
  };

  // Stop the camera and remove this Share Spot from the Host Console.
  const cleanupStream = () => {
    stopCamera();
    if (registeredRef.current && sessionId) {
      registeredRef.current = false;
      deleteDoc(sessionRef()).catch((err) => {
        handleFirestoreError(err, OperationType.DELETE, `sessions/${sessionId}`);
      });
    }
  };

  const handleExit = () => {
    cleanupStream();
    onExit();
  };

  if (!isRegistered) {
    return (
      <div className="min-h-screen bg-black text-g2-text flex flex-col justify-center items-center p-6 font-sans relative overflow-hidden">
        {/* Decorative background gradients */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-g2-blue/5 rounded-full blur-[100px] pointer-events-none" />

        <div className="absolute top-4 left-4">
          <button
            onClick={handleExit}
            className="flex items-center gap-1.5 text-xs text-g2-tertiary hover:text-g2-text transition-all duration-300 cursor-pointer bg-white/5 border border-white/5 hover:border-white/10 px-3 py-1.5 rounded-lg backdrop-blur-md"
          >
            <X className="w-4 h-4" /> Back
          </button>
        </div>

        <div className="w-full max-w-sm bg-g2-panel border border-white/[0.08] rounded-xl p-6 space-y-6 relative z-10">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 bg-g2-blue text-white rounded-xl flex items-center justify-center mx-auto mb-3">
              <Camera className="w-8 h-8" />
            </div>
            <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">Share Spot setup</p>
            <h1 className="font-expanded font-black text-2xl leading-tight text-white">Connect this device</h1>
            <p className="text-xs text-g2-tertiary leading-relaxed">
              Mount it on a stand, keep it plugged in, and enter the code from the Host Console. Only the event host can add Share Spots.
            </p>
          </div>

          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="spot-code" className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary">
                Pairing code
              </label>
              <input
                id="spot-code"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="ABC 123"
                value={formatPairingCode(normalizePairingCode(pairingCode))}
                onChange={(e) => { setPairingCode(normalizePairingCode(e.target.value)); setError(''); }}
                className="w-full bg-g2-page border border-white/10 focus:border-g2-blue focus:ring-1 focus:ring-g2-blue/30 rounded-xl px-4 py-3 text-white placeholder-g2-muted focus:outline-none transition-all font-mono text-2xl tracking-[0.2em] text-center uppercase"
              />
              <p className="text-[11px] text-g2-muted">The host gets this code under Share Spots → Add a Share Spot.</p>
            </div>

            {error && (
              <div className="p-3 bg-red-500/5 border border-red-500/25 rounded-xl flex items-start gap-2 text-xs text-red-400">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <fieldset className="space-y-1.5">
              <legend className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary mb-1.5">
                Which camera?
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: 'user', label: 'Front', hint: 'Guests see themselves' },
                  { value: 'environment', label: 'Back', hint: 'Points at the room' },
                ] as const).map((opt) => {
                  const active = facingMode === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setFacingMode(opt.value)}
                      className={`rounded-xl px-3 py-2.5 text-left border transition-colors cursor-pointer ${
                        active ? 'border-g2-blue bg-g2-blue/10' : 'border-white/10 hover:border-white/25'
                      }`}
                    >
                      <span className="block text-sm font-bold text-white">{opt.label}</span>
                      <span className="block text-[11px] text-g2-tertiary">{opt.hint}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <button
              type="submit"
              disabled={connecting}
              className="w-full bg-g2-blue hover:bg-g2-blue-hover disabled:opacity-60 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-g2-blue/20 cursor-pointer disabled:cursor-default"
            >
              {connecting ? 'Connecting…' : 'Start Share Spot'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const joinUrl = joinCode ? `${origin}/e/${joinCode}` : null;
  const keepUrl = joinCode && lastPhoto ? `${origin}/e/${joinCode}?keep=${lastPhoto.id}` : null;

  return (
    <div
      className="min-h-dvh h-dvh bg-black text-g2-text font-sans relative overflow-hidden select-none cursor-pointer"
      onClick={handleTap}
      role="button"
      tabIndex={0}
      aria-label="Tap anywhere for a photo"
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleTap(); } }}
    >
      {/* Camera */}
      <video
        ref={setVideoRef}
        autoPlay
        playsInline
        muted
        className={`absolute inset-0 w-full h-full object-cover ${facingMode === 'user' ? '-scale-x-100' : ''}`}
      />

      <SpotTapLayer
        phase={spotPhase}
        count={count}
        spotName={tripodName}
        joinUrl={joinUrl}
        keepUrl={keepUrl}
        photoUrl={lastPhoto?.url ?? null}
        secondsLeft={secondsLeft}
      />

      {/* Host bar: small and out of the way. Taps here don't take a photo. */}
      <div
        className="absolute top-0 inset-x-0 z-40 p-3 flex justify-between items-center gap-2 bg-gradient-to-b from-black/70 to-transparent cursor-default"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 flex-wrap opacity-80">
          {/* Is the host's console receiving this spot's preview right now? */}
          <span
            aria-live="polite"
            className={`text-[10px] font-bold tracking-wider uppercase flex items-center gap-1.5 px-2.5 py-1 rounded-lg border backdrop-blur-md ${
              previewMode === 'off'
                ? 'bg-black/40 border-white/10 text-g2-tertiary'
                : previewMode === 'focus'
                  ? 'bg-g2-blue/25 border-g2-blue/60 text-white'
                  : 'bg-g2-live/15 border-g2-live/40 text-white'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                previewMode === 'off' ? 'bg-g2-muted' : previewMode === 'focus' ? 'bg-g2-blue-light animate-pulse' : 'bg-g2-live animate-pulse'
              }`}
            />
            {previewMode === 'off' ? 'Host view paused' : previewMode === 'focus' ? 'Host view · fast' : 'Host view · live'}
          </span>
          <span className="flex items-center gap-1.5 text-g2-tertiary text-[10px] bg-black/40 px-2.5 py-1 rounded-lg border border-white/10 backdrop-blur-md">
            <Battery className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
            {batteryLevel !== null ? `${batteryLevel}%${charging ? ' · charging' : ''}` : 'Battery —'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleFacingMode}
            aria-label="Flip camera"
            title="Flip camera"
            className="w-11 h-11 rounded-full bg-black/40 hover:bg-black/60 border border-white/20 text-white flex items-center justify-center cursor-pointer"
          >
            <RefreshCw className="w-[18px] h-[18px]" aria-hidden="true" />
          </button>
          <FullscreenButton className="text-xs px-3 py-1.5" />
          <CloseButton onClick={handleExit} label="Stop Share Spot" className="bg-black/40 hover:bg-black/60" />
        </div>
      </div>
    </div>
  );
}

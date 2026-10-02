import React, { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, X, ShieldAlert, Battery, Wifi, Settings, Zap } from 'lucide-react';
import { doc, setDoc, deleteDoc, onSnapshot, updateDoc, addDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { paths } from '../events';
import { normalizePairingCode, formatPairingCode, STORED_SPOT_CODE_KEY } from '../spotPairing';
import { BACKGROUND_MS, FOCUS_MS, FRAME, NORMAL_MS, WATCH_TIMEOUT_MS } from '../liveConsole';
import { db, compressPhoto, uploadPhotoAsset, handleFirestoreError, OperationType } from '../firebase';
import { motion } from 'motion/react';

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
  const [capturing, setCapturing] = useState(false);
  const [lastCapturedUrl, setLastCapturedUrl] = useState<string | null>(null);

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
      cleanupStream();
    };
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
          triggerShutterCapture(true);
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
      try {
        const existing = await getDoc(pairingRef); // only readable once it's ours
        if (existing.exists() && existing.data().claimedBy === sessionId) {
          spotName = existing.data().spotName;
          spotEventId = existing.data().eventId;
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
      try {
        const memberRef = paths.member(spotEventId, sessionId);
        const already = await getDoc(memberRef).then((m) => m.exists()).catch(() => false);
        if (!already) {
          await setDoc(memberRef, { nickname: spotName, joinedAt: serverTimestamp(), joinCode: code, role: 'spot' });
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
  // A local "Test Shutter" follows the event's normal approval setting.
  const triggerShutterCapture = async (fromHost: boolean = false) => {
    if (!videoRef.current || capturingRef.current) return;

    try {
      capturingRef.current = true;
      setCapturing(true);

      const video = videoRef.current;
      const captureCanvas = document.createElement('canvas');
      captureCanvas.width = video.videoWidth || 1920;
      captureCanvas.height = video.videoHeight || 1080;

      const ctx = captureCanvas.getContext('2d');
      if (!ctx) throw new Error('Could not get canvas context');

      ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

      captureCanvas.toBlob(
        async (blob) => {
          if (!blob) {
            capturingRef.current = false;
            setCapturing(false);
            return;
          }

          try {
            const file = new File([blob], `tripod_${tripodName}_${Date.now()}.jpg`, { type: 'image/jpeg' });
            // Automatic client-side canvas downscale & compress to 1200px wide, ~80% JPEG quality
            const compressedBlob = await compressPhoto(file);
            const downloadUrl = await uploadPhotoAsset(compressedBlob, `tripod_${tripodName}_${Date.now()}.jpg`);

            // Host-triggered captures publish immediately (the database verifies the
            // host fired the shutter in the last 2 minutes). Local test shots follow
            // the event's approval setting.
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
            try {
              await addDoc(paths.photos(eventIdRef.current as string), {
                url: downloadUrl,
                nickname: `${tripodName} (Share Spot)`,
                sessionId: sessionId,
                createdAt: Date.now(),
                status,
                reactions: { likes: 0, dislikes: 0 },
                flagged: false,
              });
            } catch (err) {
              handleFirestoreError(err, OperationType.CREATE, 'photos');
            }

            setLastCapturedUrl(downloadUrl);
            setTimeout(() => setLastCapturedUrl(null), 4000);
          } catch (uploadErr) {
            console.error('Tripod photo upload error:', uploadErr);
          } finally {
            capturingRef.current = false;
            setCapturing(false);
          }
        },
        'image/jpeg',
        0.95
      );
    } catch (err) {
      console.error('Shutter trigger capture error:', err);
      capturingRef.current = false;
      setCapturing(false);
    }
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

  return (
    <div className="min-h-screen bg-black text-g2-text flex flex-col justify-between font-sans relative overflow-hidden">
      {/* HUD Bar - Top */}
      <div className="p-4 bg-gradient-to-b from-black/80 to-transparent flex justify-between items-center z-10">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold tracking-wider uppercase text-g2-secondary bg-white/5 px-2.5 py-1 rounded-lg border border-white/10 backdrop-blur-md">
            Share Spot: {tripodName}
          </span>
          {/* Is the host's console receiving this spot's preview right now? */}
          <span
            aria-live="polite"
            className={`text-[11px] font-bold tracking-wider uppercase flex items-center gap-1.5 px-2.5 py-1 rounded-lg border backdrop-blur-md ${
              previewMode === 'off'
                ? 'bg-white/5 border-white/10 text-g2-tertiary'
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
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-g2-tertiary text-xs bg-white/5 px-2.5 py-1 rounded-lg border border-white/10 backdrop-blur-md">
            <Battery className="w-4 h-4 text-emerald-400" />
            <span>{batteryLevel !== null ? `${batteryLevel}%${charging ? ' · charging' : ''}` : '—'}</span>
          </div>
          <button
            onClick={handleExit}
            className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-g2-secondary transition-all duration-300 cursor-pointer"
            title="Stop Share Spot"
            aria-label="Stop Share Spot"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Camera Viewfinder */}
      <div className="absolute inset-0 bg-black flex items-center justify-center">
        <video
          ref={setVideoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-cover ${facingMode === 'user' ? '-scale-x-100' : ''}`}
        />

        {/* Technical Hud Overlay */}
        <div className="absolute inset-4 border border-white/10 pointer-events-none rounded-xl">
          <div className="absolute top-2 left-2 w-3 h-3 border-t border-l border-white/40" />
          <div className="absolute top-2 right-2 w-3 h-3 border-t border-r border-white/40" />
          <div className="absolute bottom-2 left-2 w-3 h-3 border-b border-l border-white/40" />
          <div className="absolute bottom-2 right-2 w-3 h-3 border-b border-r border-white/40" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 border border-dashed border-white/20 rounded-full flex items-center justify-center">
              <div className="w-1.5 h-1.5 bg-white rounded-full" />
            </div>
          </div>
        </div>

        {/* Captured Overlay Notification */}
        {capturing && (
          <div className="absolute inset-0 bg-white flex items-center justify-center z-20">
            <div className="text-center space-y-1">
                            <p className="font-expanded font-black text-3xl text-g2-page">
                Got it!
              </p>
              <p className="text-g2-page/70 text-sm font-semibold">
                Sending it to the gallery…
              </p>
            </div>
          </div>
        )}

        {/* Thumbnail Slide-in of last snapped frame */}
        {lastCapturedUrl && (
          <div className="absolute bottom-24 right-6 bg-g2-panel border border-white/10 p-1.5 rounded-xl shadow-2xl z-10 max-w-[110px]">
            <img
              src={lastCapturedUrl}
              alt="Last captured"
              className="w-24 h-16 object-cover rounded-lg"
            />
            <p className="text-[10px] text-white font-bold text-center mt-1">
              Posted
            </p>
          </div>
        )}
      </div>

      {/* Control HUD Bar - Bottom */}
      <div className="p-6 bg-gradient-to-t from-black/90 via-black/50 to-transparent flex justify-between items-center z-10">
        <div className="flex items-center gap-1.5 text-xs text-g2-tertiary">
          <Wifi className="w-3.5 h-3.5 text-g2-blue-light" />
          <span>
            {previewMode === 'off'
              ? 'Ready. Preview paused until the host opens the console.'
              : previewMode === 'focus'
                ? 'Ready. The host is watching this spot closely.'
                : 'Ready. The host can take a photo.'}
          </span>
        </div>
        <div className="flex gap-4">
          <button
            onClick={toggleFacingMode}
            className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 text-g2-secondary hover:text-white rounded-xl transition-all duration-300 flex items-center gap-2 text-xs font-semibold cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            Flip camera
          </button>
          <button
            onClick={() => triggerShutterCapture(false)}
            className="p-3 bg-white text-g2-page font-extrabold rounded-xl transition-all duration-300 flex items-center gap-1.5 text-xs cursor-pointer"
          >
            <Camera className="w-4 h-4" />
            Test shot
          </button>
        </div>
      </div>
    </div>
  );
}

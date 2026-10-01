import React, { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, X, ShieldAlert, Battery, Wifi, Settings, Zap } from 'lucide-react';
import { doc, setDoc, deleteDoc, onSnapshot, updateDoc, addDoc, collection, getDoc } from 'firebase/firestore';
import { db, compressPhoto, uploadPhotoAsset, handleFirestoreError, OperationType } from '../firebase';
import { motion } from 'motion/react';

interface TripodModeProps {
  onExit: () => void;
  sessionId: string;
}

export default function TripodMode({ onExit, sessionId }: TripodModeProps) {
  const [tripodName, setTripodName] = useState('');
  const [isRegistered, setIsRegistered] = useState(false);
  const [error, setError] = useState('');
  const [batteryLevel, setBatteryLevel] = useState<number | undefined>(undefined);
  // Front camera by default so guests can see themselves on the Share Spot's screen.
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [capturing, setCapturing] = useState(false);
  const [lastCapturedUrl, setLastCapturedUrl] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameStreamingIntervalRef = useRef<any>(null);
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
    if (frameStreamingIntervalRef.current) {
      clearInterval(frameStreamingIntervalRef.current);
      frameStreamingIntervalRef.current = null;
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

  // Monitor battery levels if supported by the browser
  useEffect(() => {
    if ('getBattery' in navigator) {
      (navigator as any).getBattery().then((battery: any) => {
        setBatteryLevel(Math.round(battery.level * 100));
        battery.addEventListener('levelchange', () => {
          setBatteryLevel(Math.round(battery.level * 100));
        });
      });
    }
  }, []);

  // Sync battery changes to Firestore once registered
  useEffect(() => {
    if (!isRegistered || !sessionId) return;
    const docRef = doc(db, 'sessions', sessionId);
    updateDoc(docRef, {
      'deviceInfo.batteryLevel': batteryLevel || 100,
    }).catch((err) => {
      handleFirestoreError(err, OperationType.UPDATE, `sessions/${sessionId}`);
    });
  }, [batteryLevel, isRegistered, sessionId]);

  // Handle stream cleanup
  useEffect(() => {
    return () => {
      cleanupStream();
    };
  }, []);

  // Listen to remote trigger command from the Host
  useEffect(() => {
    if (!isRegistered || !sessionId) return;

    const docRef = doc(db, 'sessions', sessionId);
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
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
    if (!tripodName.trim()) {
      setError('Give this Share Spot a name, like "Stage".');
      return;
    }

    try {
      setError('');
      // Request camera access (front camera by default)
      attachStream(await openCamera(facingMode));

      // Register this device as a Tripod in the Sessions Firestore collection
      const docRef = doc(db, 'sessions', sessionId);
      try {
        await setDoc(docRef, {
          sessionId: sessionId,
          nickname: tripodName.trim(),
          role: 'tripod',
          lastActive: Date.now(),
          deviceInfo: {
            batteryLevel: batteryLevel || 100,
            userAgent: navigator.userAgent,
            deviceName: `${tripodName.trim()} Lens`,
          },
          lens_status: 'streaming',
          invited_to_lens: false,
          trigger_shutter: false,
        }, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `sessions/${sessionId}`);
      }

      registeredRef.current = true;
      setIsRegistered(true);

      // Start periodic low-res thumbnail frame streaming (monitoring feed)
      startFrameStreaming();
    } catch (err) {
      console.error(err);
      setError("Couldn't open the camera. Allow camera access for this site and try again.");
    }
  };

  const startFrameStreaming = () => {
    if (frameStreamingIntervalRef.current) clearInterval(frameStreamingIntervalRef.current);

    let frameInFlight = false;
    frameStreamingIntervalRef.current = setInterval(() => {
      if (!videoRef.current || !streamRef.current || !registeredRef.current) return;
      // On a slow connection, skip this tick rather than stacking up writes.
      if (frameInFlight) return;
      if (!videoRef.current.videoWidth) return; // camera not ready yet

      const video = videoRef.current;
      if (!canvasRef.current) {
        canvasRef.current = document.createElement('canvas');
      }

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Small monitoring frame for the Host Console
      const width = 320;
      const height = Math.round((video.videoHeight / video.videoWidth) * width) || 180;
      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(video, 0, 0, width, height);

      // Low quality (0.5) to keep document updates lightning-fast
      const base64Frame = canvas.toDataURL('image/jpeg', 0.5);

      const docRef = doc(db, 'sessions', sessionId);
      frameInFlight = true;
      updateDoc(docRef, {
        stream_frame: base64Frame,
        lastActive: Date.now(),
      })
        .catch((err) => {
          handleFirestoreError(err, OperationType.UPDATE, `sessions/${sessionId}`);
        })
        .finally(() => {
          frameInFlight = false;
        });
    }, 1500);
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
                const settingsSnap = await getDoc(doc(db, 'settings', 'event-settings'));
                if (settingsSnap.exists() && settingsSnap.data().autoApproval === true) status = 'approved';
              } catch {
                // keep 'pending'
              }
            }
            try {
              await addDoc(collection(db, 'photos'), {
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
      deleteDoc(doc(db, 'sessions', sessionId)).catch((err) => {
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
            <h1 className="font-expanded font-black text-2xl leading-tight text-white">Make this phone a Share Spot</h1>
            <p className="text-xs text-g2-tertiary leading-relaxed">
              Mount it on a stand, keep it plugged in, and give it a name. The host sees what it sees and can take a photo from anywhere in the room.
            </p>
          </div>

          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="spot-name" className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary">
                Where is it?
              </label>
              <input
                id="spot-name"
                type="text"
                placeholder="e.g. Stage, Bar, Balcony"
                value={tripodName}
                onChange={(e) => setTripodName(e.target.value)}
                maxLength={20}
                className="w-full bg-g2-panel/80 border border-white/10 focus:border-g2-blue focus:ring-1 focus:ring-g2-blue/30 rounded-xl px-4 py-3 text-white placeholder-g2-muted focus:outline-none transition-all text-sm"
              />
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
              className="w-full bg-g2-blue hover:bg-g2-blue-hover text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-g2-blue/20 cursor-pointer"
            >
              Start Share Spot
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
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold tracking-wider uppercase text-g2-secondary flex items-center gap-1 bg-white/5 px-2.5 py-1 rounded-lg border border-white/10 backdrop-blur-md">
            <span className="w-2 h-2 bg-g2-live rounded-full animate-pulse mr-1" />
            Live · Share Spot: {tripodName}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-g2-tertiary text-xs bg-white/5 px-2.5 py-1 rounded-lg border border-white/10 backdrop-blur-md">
            <Battery className="w-4 h-4 text-emerald-400" />
            <span>{batteryLevel !== undefined ? `${batteryLevel}%` : '100%'}</span>
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
          <span>Ready. The host can take a photo.</span>
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

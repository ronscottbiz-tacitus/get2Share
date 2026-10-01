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
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [capturing, setCapturing] = useState(false);
  const [lastCapturedUrl, setLastCapturedUrl] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameStreamingIntervalRef = useRef<any>(null);

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
      setError('Please provide a unique name for this Tripod');
      return;
    }

    try {
      setError('');
      // Request Camera Access
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

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

      setIsRegistered(true);

      // Start periodic low-res thumbnail frame streaming (monitoring feed)
      startFrameStreaming();
    } catch (err) {
      console.error(err);
      setError('Could not access camera. Make sure camera permission is granted.');
    }
  };

  const startFrameStreaming = () => {
    if (frameStreamingIntervalRef.current) clearInterval(frameStreamingIntervalRef.current);

    frameStreamingIntervalRef.current = setInterval(() => {
      if (!videoRef.current || !streamRef.current || !isRegistered) return;

      const video = videoRef.current;
      if (!canvasRef.current) {
        canvasRef.current = document.createElement('canvas');
      }

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Small monitoring frame
      const width = 240;
      const height = Math.round((video.videoHeight / video.videoWidth) * width) || 180;
      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(video, 0, 0, width, height);

      // Low quality (0.5) to keep document updates lightning-fast
      const base64Frame = canvas.toDataURL('image/jpeg', 0.5);

      const docRef = doc(db, 'sessions', sessionId);
      updateDoc(docRef, {
        stream_frame: base64Frame,
        lastActive: Date.now(),
      }).catch((err) => {
        handleFirestoreError(err, OperationType.UPDATE, `sessions/${sessionId}`);
      });
    }, 700);
  };

  // fromHost = the host fired the remote shutter (publishes immediately).
  // A local "Test Shutter" follows the event's normal approval setting.
  const triggerShutterCapture = async (fromHost: boolean = false) => {
    if (!videoRef.current || capturing) return;

    try {
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
                nickname: `${tripodName} (Tripod)`,
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
            setCapturing(false);
          }
        },
        'image/jpeg',
        0.95
      );
    } catch (err) {
      console.error('Shutter trigger capture error:', err);
      setCapturing(false);
    }
  };

  const toggleFacingMode = async () => {
    const nextFacing = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(nextFacing);

    cleanupStream();

    setTimeout(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: nextFacing,
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }

        if (isRegistered) {
          startFrameStreaming();
        }
      } catch (err) {
        console.error('Camera switch failed:', err);
      }
    }, 150);
  };

  const cleanupStream = () => {
    if (frameStreamingIntervalRef.current) {
      clearInterval(frameStreamingIntervalRef.current);
      frameStreamingIntervalRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (isRegistered && sessionId) {
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
      <div className="min-h-screen bg-black text-slate-100 flex flex-col justify-center items-center p-6 font-sans relative overflow-hidden">
        {/* Decorative background gradients */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-[#00f2ff]/5 rounded-full blur-[100px] pointer-events-none" />

        <div className="absolute top-4 left-4">
          <button
            onClick={handleExit}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-all duration-300 cursor-pointer bg-white/5 border border-white/5 hover:border-white/10 px-3 py-1.5 rounded-lg backdrop-blur-md"
          >
            <X className="w-4 h-4" /> Go Back
          </button>
        </div>

        <div className="w-full max-w-sm glass-card neon-border rounded-2xl p-6 shadow-2xl space-y-6 relative z-10">
          <div className="text-center space-y-2">
            <div className="p-3 bg-[#00f2ff]/5 text-[#00f2ff] border border-[#00f2ff]/20 rounded-2xl w-fit mx-auto mb-2 shadow-[0_0_15px_rgba(0,242,255,0.05)]">
              <Camera className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Stationary Tripod Node</h1>
            <p className="text-xs text-slate-400 leading-relaxed">
              Mount this device on a stand, name it, and register it. The host can view this camera feed from their pocket and trigger shutter taps remotely.
            </p>
          </div>

          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Tripod Location / Name
              </label>
              <input
                type="text"
                placeholder="e.g. DJ Booth, Bar Counter, Stage Wide"
                value={tripodName}
                onChange={(e) => setTripodName(e.target.value)}
                maxLength={20}
                className="w-full bg-[#0c0c0c]/80 border border-white/10 focus:border-[#00f2ff] focus:ring-1 focus:ring-[#00f2ff]/30 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none transition-all text-sm"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-500/5 border border-red-500/25 rounded-xl flex items-start gap-2 text-xs text-red-400">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-bold py-3 rounded-xl transition-all shadow-lg shadow-[#00f2ff]/20 cursor-pointer"
            >
              Start Tripod Stream
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-slate-100 flex flex-col justify-between font-sans relative overflow-hidden">
      {/* HUD Bar - Top */}
      <div className="p-4 bg-gradient-to-b from-black/80 to-transparent flex justify-between items-center z-10">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold tracking-wider uppercase text-slate-300 flex items-center gap-1 bg-white/5 px-2.5 py-1 rounded-lg border border-white/10 backdrop-blur-md">
            <span className="w-2 h-2 bg-red-500 rounded-full animate-ping mr-1" />
            LIVE: {tripodName}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-slate-400 text-xs bg-white/5 px-2.5 py-1 rounded-lg border border-white/10 backdrop-blur-md">
            <Battery className="w-4 h-4 text-emerald-400" />
            <span>{batteryLevel !== undefined ? `${batteryLevel}%` : '100%'}</span>
          </div>
          <button
            onClick={handleExit}
            className="p-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-slate-300 transition-all duration-300 cursor-pointer"
            title="Exit Tripod Mode"
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
          className="w-full h-full object-cover"
        />

        {/* Technical Hud Overlay */}
        <div className="absolute inset-4 border border-white/10 pointer-events-none rounded-xl">
          <div className="absolute top-2 left-2 w-3 h-3 border-t border-l border-white/40" />
          <div className="absolute top-2 right-2 w-3 h-3 border-t border-r border-white/40" />
          <div className="absolute bottom-2 left-2 w-3 h-3 border-b border-l border-white/40" />
          <div className="absolute bottom-2 right-2 w-3 h-3 border-b border-r border-white/40" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 border border-dashed border-white/20 rounded-full flex items-center justify-center">
              <div className="w-1.5 h-1.5 bg-[#00f2ff] rounded-full animate-pulse" />
            </div>
          </div>
        </div>

        {/* Captured Overlay Notification */}
        {capturing && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center animate-fade-out z-20">
            <div className="text-center space-y-1">
              <Zap className="w-12 h-12 text-[#00f2ff] animate-bounce mx-auto" />
              <p className="text-black font-extrabold text-2xl tracking-widest uppercase">
                Remote Shutter
              </p>
              <p className="text-slate-600 text-xs font-semibold">
                Uploading fresh high-res event snap...
              </p>
            </div>
          </div>
        )}

        {/* Thumbnail Slide-in of last snapped frame */}
        {lastCapturedUrl && (
          <div className="absolute bottom-20 right-6 glass-card neon-border p-1.5 rounded-xl shadow-2xl z-10 max-w-[110px] animate-slide-in">
            <img
              src={lastCapturedUrl}
              alt="Last captured"
              className="w-24 h-16 object-cover rounded-lg"
            />
            <p className="text-[10px] text-[#00f2ff] font-bold text-center mt-1">
              Snapped!
            </p>
          </div>
        )}
      </div>

      {/* Control HUD Bar - Bottom */}
      <div className="p-6 bg-gradient-to-t from-black/90 via-black/50 to-transparent flex justify-between items-center z-10">
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <Wifi className="w-3.5 h-3.5 text-[#00f2ff]" />
          <span>Listening for Host Commands</span>
        </div>
        <div className="flex gap-4">
          <button
            onClick={toggleFacingMode}
            className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 hover:text-white rounded-xl transition-all duration-300 flex items-center gap-2 text-xs font-semibold cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            Flip Camera
          </button>
          <button
            onClick={() => triggerShutterCapture(false)}
            className="p-3 bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-extrabold rounded-xl transition-all duration-300 flex items-center gap-1.5 text-xs cursor-pointer shadow-lg shadow-[#00f2ff]/20"
          >
            <Camera className="w-4 h-4" />
            Test Shutter
          </button>
        </div>
      </div>
    </div>
  );
}

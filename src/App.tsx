import { useState, useEffect, useRef } from 'react';
import GuestOnboarding from './components/GuestOnboarding';
import LiveGalleryFeed from './components/LiveGalleryFeed';
import PhotoLightbox from './components/PhotoLightbox';
import HostDashboard from './components/HostDashboard';
import TripodMode from './components/TripodMode';
import ProjectionSlideshow from './components/ProjectionSlideshow';
import { Photo } from './types';
import { Camera, X, Check } from 'lucide-react';
import { doc, updateDoc, onSnapshot, addDoc, collection } from 'firebase/firestore';
import { onAuthStateChanged, signInAnonymously, signInWithPopup, signOut, User } from 'firebase/auth';
import { db, auth, googleProvider, compressPhoto, uploadPhotoAsset } from './firebase';
import { isHostEmail } from './hosts';
import { motion, AnimatePresence } from 'motion/react';

export default function App() {
  // Session ID is the Firebase Auth uid (anonymous for guests, Google for the host).
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [hostSignInError, setHostSignInError] = useState('');
  const sessionId = authUser?.uid ?? '';
  const isHost = !!authUser && !authUser.isAnonymous && authUser.emailVerified && isHostEmail(authUser.email);

  const [nickname, setNickname] = useState<string>('');
  const [currentView, setCurrentView] = useState<'onboarding' | 'gallery' | 'host' | 'tripod' | 'slideshow'>('onboarding');

  // Favorites & Hidden Photos persisted locally
  const [favorites, setFavorites] = useState<string[]>([]);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);

  // Selected photo for the active lightbox modal
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);

  // 1. ADD THESE STATES AND REFS AT THE TOP OF YOUR APP COMPONENT
  const [lensState, setLensState] = useState<{
    activeRequester: string | null;      // Session ID of the targeted guest (e.g., 'user-sarah')
    status: 'idle' | 'invited' | 'connected' | 'flashing';
    liveViewfinderFrame: string | null;  // Real-time low-res preview Base64 string (~5KB)
    triggerRequested: boolean;           // Flag written by Host to command a capture
  }>({
    activeRequester: null,
    status: 'idle',
    liveViewfinderFrame: null,
    triggerRequested: false
  });

  const localStreamRef = useRef<MediaStream | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const streamIntervalRef = useRef<any>(null);

  // Keep a signed-in Firebase user at all times. Guests get a silent anonymous
  // account; the database rules use its uid to decide what each device may do.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setAuthUser(user);
        setAuthReady(true);
        setAuthError('');
      } else {
        setAuthUser(null);
        signInAnonymously(auth).catch((err) => {
          console.error('Anonymous sign-in failed:', err);
          setAuthError(
            'Could not connect to the event. Check your connection and reload. (If you are the organizer: enable Anonymous sign-in in Firebase Authentication.)'
          );
          setAuthReady(true);
        });
      }
    });
    return () => unsubscribe();
  }, []);

  // Initialize nickname and local caches
  useEffect(() => {
    // Old builds stored a random session ID here; identity now comes from Firebase Auth.
    localStorage.removeItem('get2share-session-id');

    // 1. Nickname persistence
    const storedNickname = localStorage.getItem('get2share-nickname') || '';
    setNickname(storedNickname);

    if (storedNickname) {
      setCurrentView('gallery');
    } else {
      setCurrentView('onboarding');
    }

    // 2. Load favorites and hidden IDs
    const storedFavs = JSON.parse(localStorage.getItem('get2share-favorites') || '[]');
    setFavorites(storedFavs);

    const storedHidden = JSON.parse(localStorage.getItem('get2share-hidden-ids') || '[]');
    setHiddenIds(storedHidden);
  }, []);

  const handleJoinEvent = (enteredNickname: string) => {
    localStorage.setItem('get2share-nickname', enteredNickname);
    setNickname(enteredNickname);
    setCurrentView('gallery');
  };

  const handleExitSession = () => {
    if (window.confirm('Are you sure you want to log out and clear all your guest session data? This will reset your device identity so you can register a new profile.')) {
      localStorage.removeItem('get2share-nickname');
      setNickname('');
      // Signing out triggers a fresh anonymous identity via onAuthStateChanged.
      signOut(auth).catch((err) => console.error('Sign-out failed:', err));
      setCurrentView('onboarding');
    }
  };

  // Host sign-in with Google. The database rules only grant host powers to
  // the accounts listed in firestore.rules (mirrored in src/hosts.ts).
  const handleHostSignIn = async () => {
    setHostSignInError('');
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (!isHostEmail(result.user.email)) {
        setHostSignInError(`${result.user.email ?? 'This account'} is not an event host. Signed back out.`);
        await signOut(auth);
      }
    } catch (err: any) {
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
      console.error('Host sign-in failed:', err);
      setHostSignInError(
        err?.code === 'auth/unauthorized-domain'
          ? 'This website address is not authorized for sign-in yet. Add it under Firebase Authentication → Settings → Authorized domains.'
          : 'Google sign-in failed. Please try again.'
      );
    }
  };

  const handleHostSignOut = async () => {
    await signOut(auth).catch((err) => console.error('Sign-out failed:', err));
  };

  const handleToggleFavorite = (id: string) => {
    let updated;
    if (favorites.includes(id)) {
      updated = favorites.filter((fId) => fId !== id);
    } else {
      updated = [...favorites, id];
    }
    setFavorites(updated);
    localStorage.setItem('get2share-favorites', JSON.stringify(updated));
  };

  const handleToggleHideLocally = (id: string) => {
    let updated;
    if (hiddenIds.includes(id)) {
      updated = hiddenIds.filter((hId) => hId !== id);
    } else {
      updated = [...hiddenIds, id];
    }
    setHiddenIds(updated);
    localStorage.setItem('get2share-hidden-ids', JSON.stringify(updated));
  };

  // Callback ref to bind the stream as soon as the video element mounts in the DOM
  const setVideoElementRef = (node: HTMLVideoElement | null) => {
    videoElementRef.current = node;
    if (node && localStreamRef.current) {
      node.srcObject = localStreamRef.current;
      node.play().catch((err) => {
        console.error("Error starting video playback:", err);
      });
    }
  };

  // 2. GUEST-SIDE: CAMERA STREAMING AND LOW-RES IMAGE PIPELINE
  const startGuestCameraStream = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error("MediaDevices API is not available in this environment.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      }).catch(async (err) => {
        console.warn("Back camera constraint failed, falling back to default camera:", err);
        return await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      });
      localStreamRef.current = stream;

      if (videoElementRef.current) {
        videoElementRef.current.srcObject = stream;
        videoElementRef.current.play().catch((playErr) => {
          console.error("Error playing video stream:", playErr);
        });
      }
      setLensState(prev => ({ ...prev, status: 'connected' }));

      // Update guest's Firestore status to 'streaming' so host receives stream
      if (sessionId) {
        const docRef = doc(db, 'sessions', sessionId);
        updateDoc(docRef, {
          lens_status: 'streaming',
          lastActive: Date.now()
        }).catch((e) => console.error('Error starting stream in db:', e));
      }

      // Capture dynamic low-res viewfinder frame (~5KB) every 1.5 seconds to sync to Host
      streamIntervalRef.current = setInterval(() => {
        if (videoElementRef.current && canvasElementRef.current) {
          const video = videoElementRef.current;
          const canvas = canvasElementRef.current;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          
          // Target ultra-low res to minimize database footprint
          canvas.width = 160;
          canvas.height = 120;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          const tinyFrame = canvas.toDataURL('image/jpeg', 0.35); // 35% quality
          
          // Update state
          setLensState(prev => ({ ...prev, liveViewfinderFrame: tinyFrame }));

          if (sessionId) {
            const docRef = doc(db, 'sessions', sessionId);
            updateDoc(docRef, {
              stream_frame: tinyFrame,
              lastActive: Date.now()
            }).catch((e) => console.error('Error writing stream frame:', e));
          }
        }
      }, 1500);
    } catch (err) {
      console.error("Camera access failed:", err);
      setLensState(prev => ({ ...prev, status: 'idle', activeRequester: null }));
      if (sessionId) {
        const docRef = doc(db, 'sessions', sessionId);
        updateDoc(docRef, {
          lens_status: 'declined',
          invited_to_lens: false
        }).catch(() => {});
      }
    }
  };

  const cleanupCameraStream = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (streamIntervalRef.current) {
      clearInterval(streamIntervalRef.current);
      streamIntervalRef.current = null;
    }
    setLensState({ activeRequester: null, status: 'idle', liveViewfinderFrame: null, triggerRequested: false });

    if (sessionId) {
      const docRef = doc(db, 'sessions', sessionId);
      updateDoc(docRef, {
        lens_status: 'off',
        invited_to_lens: false,
        stream_frame: null,
        trigger_shutter: false
      }).catch(() => {});
    }
  };

  const handleDeclineLens = async () => {
    if (sessionId) {
      const docRef = doc(db, 'sessions', sessionId);
      await updateDoc(docRef, {
        lens_status: 'declined',
        invited_to_lens: false
      }).catch(() => {});
    }
    setLensState(prev => ({ ...prev, status: 'idle', activeRequester: null }));
  };

  // 3. GUEST-SIDE: LISTEN FOR COMMAND TO TRIGGER HIGH-RES SHUTTER
  useEffect(() => {
    if (lensState.triggerRequested && lensState.status === 'connected') {
      // Flash effect
      setLensState(prev => ({ ...prev, status: 'flashing' }));

      setTimeout(() => {
        if (!videoElementRef.current) {
          cleanupCameraStream();
          return;
        }
        const video = videoElementRef.current;
        const captureCanvas = document.createElement('canvas');
        captureCanvas.width = 1200;
        captureCanvas.height = 900;
        const ctx = captureCanvas.getContext('2d');
        if (!ctx) {
          cleanupCameraStream();
          return;
        }
        ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

        captureCanvas.toBlob(
          async (blob) => {
            if (!blob) {
              cleanupCameraStream();
              return;
            }

            try {
              const rawFile = new File([blob], `lens_snap_${Date.now()}.jpg`, { type: 'image/jpeg' });
              const compressed = await compressPhoto(rawFile);
              const fileUrl = await uploadPhotoAsset(compressed, `lens_snap_${Date.now()}.jpg`);

              // Create new photo item in Firestore
              await addDoc(collection(db, 'photos'), {
                url: fileUrl,
                nickname: `${nickname} (Guest Lens)`,
                sessionId: sessionId,
                createdAt: Date.now(),
                status: 'approved',
                reactions: { likes: 0, dislikes: 0 },
                flagged: false
              });
            } catch (e) {
              console.error('Failed to upload lens snap:', e);
            } finally {
              cleanupCameraStream();
            }
          },
          'image/jpeg',
          0.95
        );
      }, 250);
    }
  }, [lensState.triggerRequested]);

  // Guest-side: listen for live invitations and triggers from Firestore
  useEffect(() => {
    if (!sessionId || currentView !== 'gallery') return;

    const docRef = doc(db, 'sessions', sessionId);
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.invited_to_lens && data.lens_status === 'requesting') {
          setLensState(prev => {
            if (prev.status === 'connected' || prev.status === 'flashing') {
              return prev;
            }
            return {
              ...prev,
              status: 'invited',
              activeRequester: data.invited_by || 'host'
            };
          });
        } else if (data.lens_status === 'off' || !data.invited_to_lens) {
          if (lensState.status === 'connected' || lensState.status === 'invited') {
            cleanupCameraStream();
          }
        } else if (data.trigger_shutter === true) {
          setLensState(prev => ({ ...prev, triggerRequested: true }));
          updateDoc(docRef, { trigger_shutter: false }).catch(() => {});
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, [sessionId, currentView, lensState.status]);

  // Wait for the silent sign-in before showing anything that reads the database.
  if (!authReady || (!authUser && !authError)) {
    return (
      <div className="bg-slate-950 text-slate-400 min-h-screen flex items-center justify-center font-sans text-sm">
        Connecting to the event…
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6 font-sans">
        <div className="max-w-sm text-center space-y-4">
          <p className="text-sm text-red-300">{authError}</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-[#00f2ff] text-slate-950 font-bold px-4 py-2 rounded-xl text-sm cursor-pointer"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-950 text-slate-100 min-h-screen selection:bg-cyan-500 selection:text-slate-950 antialiased">
      {/* 1. Onboarding Landing View */}
      {currentView === 'onboarding' && (
        <GuestOnboarding
          onJoin={handleJoinEvent}
          onGoToHost={() => setCurrentView('host')}
          onGoToTripod={() => setCurrentView('tripod')}
        />
      )}

      {/* 2. Live Gallery Feed View */}
      {currentView === 'gallery' && (
        <>
          <LiveGalleryFeed
            sessionId={sessionId}
            nickname={nickname}
            onOpenLightbox={(photo) => setSelectedPhoto(photo)}
            onExitSession={handleExitSession}
            favorites={favorites}
            hiddenIds={hiddenIds}
            onGoToHost={() => setCurrentView('host')}
            isHost={isHost}
          />
          
          {/* Background ad-hoc Tap-To-Acquire overlay/viewfinder for active participants */}
          <AnimatePresence>
            {lensState.status === 'invited' && (
              <motion.div
                initial={{ opacity: 0, y: -50 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -50 }}
                className="fixed top-4 left-4 right-4 bg-slate-900/95 border border-[#00f2ff]/30 rounded-2xl p-5 shadow-2xl z-50 text-slate-100 font-sans"
              >
                <div className="flex gap-4">
                  <div className="p-3 bg-white/5 border border-white/10 text-[#00f2ff] rounded-xl shrink-0 h-fit shadow-[0_0_10px_rgba(0,242,255,0.15)]">
                    <Camera className="w-6 h-6 animate-pulse" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="font-bold text-base text-white">📸 Share Your Lens!</h3>
                    <p className="text-xs text-slate-300">
                      The host wants to use your camera for a dynamic live group shot. Turn your phone towards the group!
                    </p>
                    <div className="flex gap-3 pt-3">
                      <button
                        onClick={startGuestCameraStream}
                        className="bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-bold px-4 py-2 rounded-xl text-xs flex items-center gap-1 cursor-pointer transition-all duration-300 shadow-md shadow-[#00f2ff]/20"
                      >
                        <Check className="w-4 h-4" /> Share My Lens
                      </button>
                      <button
                        onClick={handleDeclineLens}
                        className="bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white border border-white/10 font-medium px-4 py-2 rounded-xl text-xs flex items-center gap-1 cursor-pointer transition-all duration-300"
                      >
                        <X className="w-4 h-4" /> Decline
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {(lensState.status === 'connected' || lensState.status === 'flashing') && (
            <div className="fixed inset-0 bg-black z-50 flex flex-col justify-between font-sans">
              <div className="p-4 bg-gradient-to-b from-black/80 to-transparent flex justify-between items-center z-10">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-ping" />
                  <span className="text-xs font-semibold text-slate-200 tracking-wider uppercase">
                    Active Group Lens: Streaming
                  </span>
                </div>
                <button
                  onClick={cleanupCameraStream}
                  className="p-2 bg-slate-900/80 hover:bg-slate-800 text-slate-300 rounded-full border border-slate-800 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="absolute inset-0 flex items-center justify-center bg-black">
                <video
                  ref={setVideoElementRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                
                {lensState.status === 'flashing' && (
                  <div className="absolute inset-0 bg-white flex items-center justify-center z-50">
                    <span className="text-black font-extrabold text-2xl tracking-widest animate-pulse">
                      SNAPPED!
                    </span>
                  </div>
                )}
              </div>

              <canvas ref={canvasElementRef} className="hidden" />

              <div className="p-6 bg-gradient-to-t from-black/90 to-transparent flex flex-col items-center gap-3 z-10 text-center">
                <p className="text-xs text-slate-300 max-w-xs font-medium">
                  Point your phone at the scene. The host is framing and will snap the photo remotely from their device!
                </p>
                <div className="flex gap-4 mt-2">
                  <button
                    onClick={cleanupCameraStream}
                    className="bg-red-500/25 hover:bg-red-500/35 text-red-300 border border-red-500/30 px-4 py-2.5 rounded-xl text-xs font-bold cursor-pointer transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* 3. Event Host Console View */}
      {currentView === 'host' && (
        <HostDashboard
          sessionId={sessionId}
          onLaunchSlideshow={() => setCurrentView('slideshow')}
          onExit={() => {
            if (nickname) {
              setCurrentView('gallery');
            } else {
              setCurrentView('onboarding');
            }
          }}
          lensState={lensState}
          setLensState={setLensState}
          isHost={isHost}
          signedInEmail={authUser.isAnonymous ? null : authUser.email}
          authError={hostSignInError}
          onHostSignIn={handleHostSignIn}
          onHostSignOut={handleHostSignOut}
        />
      )}

      {/* 4. Stationary Tripod Mode View */}
      {currentView === 'tripod' && (
        <TripodMode
          sessionId={sessionId}
          onExit={() => {
            if (nickname) {
              setCurrentView('gallery');
            } else {
              setCurrentView('onboarding');
            }
          }}
        />
      )}

      {/* 5. Projector Slideshow Presentation View */}
      {currentView === 'slideshow' && (
        <ProjectionSlideshow onClose={() => setCurrentView('host')} />
      )}

      {/* 6. Photo Lightbox Modal overlay */}
      {selectedPhoto && (
        <PhotoLightbox
          photo={selectedPhoto}
          onClose={() => setSelectedPhoto(null)}
          sessionId={sessionId}
          isFavorite={favorites.includes(selectedPhoto.id)}
          onToggleFavorite={handleToggleFavorite}
          isHiddenLocally={hiddenIds.includes(selectedPhoto.id)}
          onToggleHideLocally={handleToggleHideLocally}
          isHost={isHost}
        />
      )}
    </div>
  );
}

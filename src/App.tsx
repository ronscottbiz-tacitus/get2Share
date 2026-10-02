import React, { useState, useEffect, useRef, useCallback } from 'react';
import GuestOnboarding from './components/GuestOnboarding';
import LiveGalleryFeed from './components/LiveGalleryFeed';
import PhotoLightbox from './components/PhotoLightbox';
import HostDashboard from './components/HostDashboard';
import HostHome from './components/HostHome';
import Landing from './components/Landing';
import Keepsake from './components/Keepsake';
import TripodMode from './components/TripodMode';
import { SPOT_SETUP_PATH } from './spotPairing';
import ProjectionSlideshow from './components/ProjectionSlideshow';
import { Photo } from './types';
import { X, Check, Users } from 'lucide-react';
import { updateDoc, onSnapshot, addDoc, getDoc } from 'firebase/firestore';
import { linkWithPopup, onAuthStateChanged, signInAnonymously, signInWithPopup, signOut, User } from 'firebase/auth';
import { auth, googleProvider, compressPhoto, uploadPhotoAsset } from './firebase';
import { isAdminEmail } from './hosts';
import { motion, AnimatePresence } from 'motion/react';
import {
  EVENT_PATH_PREFIX, EventWithId, HOST_PATH, isMemberOf, joinEvent, normalizeJoinCode, paths,
  findJoinedByCode, readLastEvent, rememberEvent, resolveJoinCode, JoinInfo, recordJoined, expiryOf,
} from './events';
import { EventContext } from './EventContext';

// ---------- Routes ----------
//   /              landing: join by code, or host your own
//   /e/CODE        an event's join link → nickname → live gallery
//   /host          host sign-in + "Your events" + create an event
//   /host/EVENTID  Host Console for one event
//   /spot          set up a Share Spot (needs a pairing code)

type Route =
  | { kind: 'landing'; notFound?: string }
  | { kind: 'event'; code: string }
  | { kind: 'host' }
  | { kind: 'hostEvent'; eventId: string }
  | { kind: 'spot' };

function parseRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === SPOT_SETUP_PATH) return { kind: 'spot' };
  if (p === HOST_PATH) return { kind: 'host' };
  if (p.startsWith(HOST_PATH + '/')) {
    const id = p.slice(HOST_PATH.length + 1);
    if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { kind: 'hostEvent', eventId: id };
  }
  if (p.startsWith(EVENT_PATH_PREFIX)) {
    const code = normalizeJoinCode(decodeURIComponent(p.slice(EVENT_PATH_PREFIX.length)));
    if (code.length === 6) return { kind: 'event', code };
  }
  return { kind: 'landing' };
}

type LensState = {
  activeRequester: string | null;      // Session ID of the targeted guest
  status: 'idle' | 'invited' | 'connected' | 'flashing';
  liveViewfinderFrame: string | null;  // Low-res preview
  triggerRequested: boolean;           // Set when a host fires this camera
};

export default function App() {
  // Identity is the Firebase Auth uid (anonymous for guests, Google for hosts).
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [hostSignInError, setHostSignInError] = useState('');
  const sessionId = authUser?.uid ?? '';
  const hasAccount = !!authUser && !authUser.isAnonymous;
  const isAdmin = hasAccount && !!authUser?.emailVerified && isAdminEmail(authUser?.email);

  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const navigate = useCallback((path: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setRoute(parseRoute(path));
  }, []);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // ---------- Guest side of an event (/e/CODE) ----------
  const [joinInfo, setJoinInfo] = useState<({ code: string } & JoinInfo) | null>(null);
  const [membership, setMembership] = useState<'checking' | 'member' | 'not'>('checking');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [nickname, setNickname] = useState<string>(() => {
    try { return localStorage.getItem('get2share-nickname') || ''; } catch { return ''; }
  });

  // The event being shown (guest gallery or Host Console), kept live.
  const [event, setEvent] = useState<EventWithId | null>(null);
  const [eventError, setEventError] = useState('');
  const activeEventId =
    route.kind === 'hostEvent' ? (hasAccount ? route.eventId : null)
    : route.kind === 'event' && membership === 'member' ? joinInfo?.eventId ?? null
    : null;
  const eventIdRef = useRef<string | null>(null);
  eventIdRef.current = activeEventId;
  const eventStateRef = useRef<EventWithId | null>(null);

  const [hostView, setHostView] = useState<'console' | 'slideshow'>('console');

  // "Save my photos": link this phone's guest identity to a Google account.
  const [showKeepsake, setShowKeepsake] = useState(false);
  const [savingPhotos, setSavingPhotos] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [, setAuthVersion] = useState(0);

  // Favorites & hidden photos persisted locally
  const [favorites, setFavorites] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('get2share-favorites') || '[]'); } catch { return []; }
  });
  const [hiddenIds, setHiddenIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('get2share-hidden-ids') || '[]'); } catch { return []; }
  });
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);

  // Camera sharing ("Take one of us")
  const [lensState, setLensState] = useState<LensState>({
    activeRequester: null,
    status: 'idle',
    liveViewfinderFrame: null,
    triggerRequested: false,
  });
  const localStreamRef = useRef<MediaStream | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const streamIntervalRef = useRef<any>(null);

  // 3-2-1 countdown shown on a shared guest camera before the shot is taken
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

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

  useEffect(() => {
    // Old builds stored a random session ID here; identity now comes from Firebase Auth.
    try { localStorage.removeItem('get2share-session-id'); } catch { /* ignore */ }
  }, []);

  // /e/CODE: find the event, then check whether this device already joined it.
  const routeCode = route.kind === 'event' ? route.code : null;
  useEffect(() => {
    if (!routeCode || !sessionId) return;
    let cancelled = false;
    setMembership('checking');
    setJoinError('');
    (async () => {
      try {
        const found = await resolveJoinCode(routeCode);
        if (cancelled) return;
        if (!found) {
          // The host may have made a new join link. If this device already joined
          // that event, follow it to its current code instead of turning them away.
          const joined = findJoinedByCode(routeCode);
          if (joined?.eventId && (await isMemberOf(joined.eventId, sessionId))) {
            try {
              const ev = await getDoc(paths.event(joined.eventId));
              const current = (ev.data() as any)?.joinCode as string | undefined;
              if (current && current !== routeCode && !cancelled) {
                rememberEvent({ code: current, name: (ev.data() as any)?.name || joined.name, eventId: joined.eventId });
                navigate(`${EVENT_PATH_PREFIX}${current}`, true);
                return;
              }
            } catch { /* fall through to "not found" */ }
          }
        }
        if (cancelled) return;
        if (!found) {
          setJoinInfo(null);
          navigate('/', true);
          setRoute({ kind: 'landing', notFound: routeCode });
          return;
        }
        setJoinInfo({ code: routeCode, ...found });
        const member = await isMemberOf(found.eventId, sessionId);
        if (cancelled) return;
        if (member) {
          try {
            const m = await getDoc(paths.member(found.eventId, sessionId));
            const n = (m.data() as any)?.nickname;
            if (n) setNickname(n);
          } catch { /* keep local nickname */ }
          rememberEvent({ code: routeCode, name: found.name, eventId: found.eventId });
          recordJoined(sessionId, found.eventId, { name: found.name, code: routeCode, expireAt: found.expireAt });
        }
        setMembership(member ? 'member' : 'not');
      } catch (err) {
        console.error('Event lookup failed:', err);
        if (!cancelled) {
          setJoinInfo(null);
          setJoinError("Couldn't reach the event. Check your connection and reload.");
          setMembership('not');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [routeCode, sessionId, navigate]);

  // Keep the active event live (name, settings, join code).
  useEffect(() => {
    setEvent(null);
    setEventError('');
    if (!activeEventId || !sessionId) return;
    return onSnapshot(
      paths.event(activeEventId),
      (snap) => {
        if (!snap.exists()) {
          setEventError('This event no longer exists.');
          setEvent(null);
          return;
        }
        setEvent({ id: snap.id, ...(snap.data() as any) } as EventWithId);
      },
      (err) => {
        console.error('Event listener error:', err);
        setEventError("You don't have access to this event.");
      }
    );
  }, [activeEventId, sessionId]);

  eventStateRef.current = event;
  const isEventHost =
    !!event && hasAccount && (isAdmin || (event.hostUids || []).includes(sessionId));

  const handleJoinEvent = async (enteredNickname: string) => {
    if (!joinInfo) return;
    setJoining(true);
    setJoinError('');
    try {
      await joinEvent(joinInfo.eventId, sessionId, enteredNickname, joinInfo.code, joinInfo.name, joinInfo.expireAt);
      try { localStorage.setItem('get2share-nickname', enteredNickname); } catch { /* ignore */ }
      setNickname(enteredNickname);
      rememberEvent({ code: joinInfo.code, name: joinInfo.name, eventId: joinInfo.eventId });
      setMembership('member');
    } catch (err) {
      console.error('Join failed:', err);
      setJoinError("Couldn't join. The host may have changed the event's link; ask them for the new one.");
    } finally {
      setJoining(false);
    }
  };

  const handleExitSession = () => {
    if (window.confirm('Leave this event? Your photos stay in the gallery. You can come back with the same link.')) {
      navigate('/');
    }
  };

  // Host sign-in with Google. Anyone can sign in and create an event; the
  // database rules decide which events each account can run.
  const handleHostSignIn = async () => {
    setHostSignInError('');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
      console.error('Host sign-in failed:', err);
      const code: string = err?.code || 'unknown';
      const messages: Record<string, string> = {
        'auth/unauthorized-domain': `This address (${window.location.hostname}) isn't approved for sign-in yet. Add it under Firebase → Authentication → Settings → Authorized domains.`,
        'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.',
        'auth/operation-not-allowed': 'Google sign-in is turned off for this project. Turn it on under Firebase → Authentication → Sign-in method.',
        'auth/network-request-failed': "Couldn't reach Google. Check your connection and try again.",
      };
      setHostSignInError(messages[code] ?? `Google sign-in failed (${code}). Please try again.`);
    }
  };

  // Keeps the same identity (uid), so every photo and event this phone joined
  // stays theirs, now reachable from any device by signing in.
  const handleSavePhotos = async () => {
    const user = auth.currentUser;
    if (!user) return;
    setSavingPhotos(true);
    setSaveError('');
    try {
      const res = await linkWithPopup(user, googleProvider);
      await res.user.getIdToken(true); // the database sees the account right away
      setAuthUser(res.user);
      setAuthVersion((v) => v + 1);
    } catch (err: any) {
      const code: string = err?.code || '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        // they changed their mind
      } else if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use') {
        setSaveError('That Google account is already used with Get2Share, so these photos can\'t move into it. Try a different Google account, or keep using this phone.');
      } else if (code === 'auth/provider-already-linked') {
        setAuthVersion((v) => v + 1);
      } else if (code === 'auth/unauthorized-domain') {
        setSaveError(`This address (${window.location.hostname}) isn't approved for sign-in yet. Add it under Firebase → Authentication → Settings → Authorized domains.`);
      } else if (code === 'auth/popup-blocked') {
        setSaveError('Your browser blocked the Google window. Allow pop-ups for this site and try again.');
      } else {
        console.error('Save my photos failed:', err);
        setSaveError(`Couldn't save right now (${code || 'unknown error'}). Try again.`);
      }
    } finally {
      setSavingPhotos(false);
    }
  };

  const handleHostSignOut = async () => {
    await signOut(auth).catch((err) => console.error('Sign-out failed:', err));
    navigate('/host');
  };

  const handleToggleFavorite = (id: string) => {
    const updated = favorites.includes(id) ? favorites.filter((f) => f !== id) : [...favorites, id];
    setFavorites(updated);
    try { localStorage.setItem('get2share-favorites', JSON.stringify(updated)); } catch { /* ignore */ }
  };

  const handleToggleHideLocally = (id: string) => {
    const updated = hiddenIds.includes(id) ? hiddenIds.filter((h) => h !== id) : [...hiddenIds, id];
    setHiddenIds(updated);
    try { localStorage.setItem('get2share-hidden-ids', JSON.stringify(updated)); } catch { /* ignore */ }
  };

  const inGallery = route.kind === 'event' && membership === 'member' && !!event;

  // If the host makes a new join link while a guest is in the gallery, quietly
  // move this page's address and the remembered code to the new one.
  useEffect(() => {
    if (!inGallery || !event || route.kind !== 'event' || event.joinCode === route.code) return;
    rememberEvent({ code: event.joinCode, name: event.name, eventId: event.id });
    window.history.replaceState(null, '', `${EVENT_PATH_PREFIX}${event.joinCode}`);
  }, [inGallery, event?.joinCode]);
  const galleryEventId = inGallery ? event!.id : null;

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
        const docRef = paths.session(eventIdRef.current as string, sessionId);
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
            const docRef = paths.session(eventIdRef.current as string, sessionId);
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
        const docRef = paths.session(eventIdRef.current as string, sessionId);
        updateDoc(docRef, {
          lens_status: 'declined',
          invited_to_lens: false
        }).catch(() => {});
      }
    }
  };

  const cleanupCameraStream = () => {
    countdownTimersRef.current.forEach(clearTimeout);
    countdownTimersRef.current = [];
    setCountdown(null);
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
      const docRef = paths.session(eventIdRef.current as string, sessionId);
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
      const docRef = paths.session(eventIdRef.current as string, sessionId);
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
      // Count down 3-2-1 so everyone knows the shot is coming, then flash and capture.
      const timers = countdownTimersRef.current;
      setCountdown(3);
      timers.push(setTimeout(() => setCountdown(2), 1000));
      timers.push(setTimeout(() => setCountdown(1), 2000));
      timers.push(setTimeout(() => {
      setCountdown(null);
      setLensState(prev => ({ ...prev, status: 'flashing' }));

      timers.push(setTimeout(() => {
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
              const fileUrl = await uploadPhotoAsset(compressed, `lens_snap_${Date.now()}.jpg`, eventIdRef.current as string);

              // Create new photo item in Firestore
              await addDoc(paths.photos(eventIdRef.current as string), {
                url: fileUrl,
                nickname: `${nickname} (Group Shot)`,
                sessionId: sessionId,
                createdAt: Date.now(),
                status: 'approved',
                reactions: { likes: 0, dislikes: 0 },
                flagged: false,
                ...expiryOf(eventStateRef.current),
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
      }, 250));
      }, 3000));
    }
  }, [lensState.triggerRequested]);

  // Guest-side: listen for live invitations and triggers from Firestore
  useEffect(() => {
    if (!sessionId || !inGallery || !galleryEventId) return;

    const docRef = paths.session(eventIdRef.current as string, sessionId);
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
  }, [sessionId, inGallery, galleryEventId, lensState.status]);

  // Wait for the silent sign-in before showing anything that reads the database.
  if (!authReady || (!authUser && !authError)) {
    return <Centered>Connecting…</Centered>;
  }

  if (!authUser) {
    return (
      <div className="bg-g2-page text-g2-text min-h-screen flex items-center justify-center p-6 font-sans">
        <div className="max-w-sm text-center space-y-4">
          <p className="text-sm text-red-300">{authError}</p>
          <button
            onClick={() => window.location.reload()}
            className="bg-g2-blue text-white font-bold px-4 py-2 rounded-xl text-sm cursor-pointer"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  const shell = (children: React.ReactNode) => (
    <div className="bg-g2-page text-g2-text min-h-screen selection:bg-g2-blue selection:text-white antialiased">
      {children}
    </div>
  );

  // ---------- /spot ----------
  if (route.kind === 'spot') {
    return shell(<TripodMode sessionId={sessionId} onExit={() => navigate('/')} />);
  }

  // ---------- / ----------
  if (route.kind === 'landing') {
    return shell(
      <Landing
        lastEvent={readLastEvent()}
        notFoundCode={route.notFound}
        onJoinCode={(code) => navigate(`${EVENT_PATH_PREFIX}${code}`)}
        onHost={() => navigate(HOST_PATH)}
      />
    );
  }

  // ---------- /host and /host/EVENTID ----------
  if (route.kind === 'host' || (route.kind === 'hostEvent' && (!hasAccount || eventError || (event && !isEventHost)))) {
    const notice =
      route.kind === 'hostEvent' && hasAccount
        ? "That event isn't one you host. Ask its owner to add you as a co-host."
        : route.kind === 'hostEvent'
          ? 'Sign in to open that event.'
          : undefined;
    return shell(
      <HostHome
        hasAccount={hasAccount}
        uid={sessionId}
        email={authUser.email}
        isAdmin={isAdmin}
        signInError={hostSignInError}
        notice={notice}
        onSignIn={handleHostSignIn}
        onSignOut={handleHostSignOut}
        onOpenEvent={(id) => { setHostView('console'); navigate(`${HOST_PATH}/${id}`); }}
        onOpenJoined={(j) => {
          // Seed this device's memory so an old code still finds the event.
          rememberEvent({ code: j.code, name: j.name, eventId: j.eventId });
          navigate(`${EVENT_PATH_PREFIX}${j.code}`);
        }}
        onBack={() => navigate('/')}
      />
    );
  }

  if (route.kind === 'hostEvent') {
    if (!event) return <Centered>Opening the Host Console…</Centered>;
    return shell(
      <EventContext.Provider value={{ event, isEventHost }}>
        {hostView === 'slideshow' ? (
          <ProjectionSlideshow onClose={() => setHostView('console')} />
        ) : (
          <HostDashboard
            sessionId={sessionId}
            onLaunchSlideshow={() => setHostView('slideshow')}
            onExit={() => navigate(HOST_PATH)}
            lensState={lensState}
            setLensState={setLensState}
            isHost={isEventHost}
            isAdmin={isAdmin}
            signedInEmail={authUser.isAnonymous ? null : authUser.email}
            authError={hostSignInError}
            onHostSignIn={handleHostSignIn}
            onHostSignOut={handleHostSignOut}
          />
        )}
      </EventContext.Provider>
    );
  }

  // ---------- /e/CODE ----------
  if (membership === 'checking' && !joinError) return <Centered>Finding the event…</Centered>;

  if (membership !== 'member' || !joinInfo) {
    if (!joinInfo) {
      return shell(
        <Landing
          lastEvent={readLastEvent()}
          notFoundCode={undefined}
          onJoinCode={(code) => navigate(`${EVENT_PATH_PREFIX}${code}`)}
          onHost={() => navigate(HOST_PATH)}
        />
      );
    }
    return shell(
      <GuestOnboarding
        eventName={joinInfo.name}
        defaultNickname={nickname}
        joining={joining}
        joinError={joinError}
        onJoin={handleJoinEvent}
        onGoToHost={() => navigate(HOST_PATH)}
      />
    );
  }

  if (!event) {
    return eventError ? <Centered>{eventError}</Centered> : <Centered>Opening the gallery…</Centered>;
  }

  return shell(
    <EventContext.Provider value={{ event, isEventHost }}>
      <LiveGalleryFeed
        sessionId={sessionId}
        nickname={nickname}
        onOpenLightbox={(photo) => setSelectedPhoto(photo)}
        onExitSession={handleExitSession}
        favorites={favorites}
        hiddenIds={hiddenIds}
        onGoToHost={() => navigate(`${HOST_PATH}/${event.id}`)}
        onOpenKeepsake={() => { setSaveError(''); setShowKeepsake(true); }}
        isSaved={hasAccount}
        isHost={isEventHost}
      />

      <AnimatePresence>
        {showKeepsake && (
          <Keepsake
            key="keepsake"
            sessionId={sessionId}
            nickname={nickname}
            saved={hasAccount}
            email={authUser.email}
            saving={savingPhotos}
            saveError={saveError}
            onSave={handleSavePhotos}
            onOpenAccount={() => { setShowKeepsake(false); navigate(HOST_PATH); }}
            onClose={() => setShowKeepsake(false)}
          />
        )}
      </AnimatePresence>

  {/* Camera request from the host: a bottom sheet the guest must accept */}
      <AnimatePresence>
        {lensState.status === 'invited' && (
          <motion.div
            key="lens-invite"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-g2-page/75 flex items-end justify-center font-sans"
          >
            <motion.section
              role="dialog"
              aria-modal="true"
              aria-labelledby="lens-invite-title"
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
                  <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">Host request</p>
                  <h2 id="lens-invite-title" className="mt-0.5 font-expanded font-black text-[22px] leading-tight text-white">
                    Share your camera?
                  </h2>
                </div>
              </div>
              <p className="text-sm leading-relaxed text-g2-secondary">
                The host wants to use your camera for a group shot. Point your phone at the group. The host frames it and takes the picture.
              </p>
              <ul className="flex flex-col gap-2.5">
                {[
                  "The host sees your camera only while you're sharing.",
                  'A 3-second countdown before the shot. Stop anytime.',
                ].map((line) => (
                  <li key={line} className="flex gap-2.5 items-start text-[13px] leading-normal text-g2-text">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
                    {line}
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-2 mt-1">
                <button
                  onClick={startGuestCameraStream}
                  className="h-[52px] rounded-lg bg-g2-blue hover:bg-g2-blue-hover text-white font-bold text-[15px] cursor-pointer transition-colors"
                >
                  Share my camera
                </button>
                <button
                  onClick={handleDeclineLens}
                  className="h-[52px] rounded-lg border border-white/10 text-g2-secondary hover:text-white font-semibold text-[15px] cursor-pointer transition-colors"
                >
                  Not now
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Shared camera: always shows who can see it, the countdown, and a way out */}
      {(lensState.status === 'connected' || lensState.status === 'flashing') && (
        <div className="fixed inset-0 bg-black z-50 font-sans">
          <div className="absolute inset-0 flex items-center justify-center bg-black">
            <video
              ref={setVideoElementRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
          </div>

          <header className="absolute top-0 inset-x-0 pt-4 pl-5 pr-4 flex justify-between items-center z-10">
            <div className="h-8 px-3 flex items-center gap-2 rounded-full bg-g2-page/85 border border-g2-live font-mono text-[10.5px] font-bold tracking-[0.06em] uppercase text-red-300">
              <span className="w-2 h-2 rounded-full bg-g2-live animate-pulse" />
              Live · host can see this
            </div>
            <button
              onClick={cleanupCameraStream}
              aria-label="Stop sharing"
              className="w-11 h-11 rounded-full border border-white/15 bg-g2-page/60 text-white flex items-center justify-center cursor-pointer"
            >
              <X className="w-[18px] h-[18px]" />
            </button>
          </header>

          {countdown !== null && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 z-10" aria-live="assertive">
              <p className="font-condensed font-extrabold text-[13px] tracking-[0.16em] uppercase text-white">Get ready</p>
              <div className="w-[168px] h-[168px] rounded-full border-4 border-white bg-g2-page/55 flex items-center justify-center">
                <span className="font-expanded font-black text-8xl leading-none text-white">{countdown}</span>
              </div>
            </div>
          )}

          {lensState.status === 'flashing' && (
            <div className="absolute inset-0 bg-white flex items-center justify-center z-20">
              <span className="font-expanded font-black text-3xl text-g2-page">Got it!</span>
            </div>
          )}

          <canvas ref={canvasElementRef} className="hidden" />

          <footer className="absolute bottom-0 inset-x-0 px-5 pt-5 pb-8 bg-g2-page/90 border-t border-white/[0.08] flex flex-col gap-3.5 z-10">
            <p className="text-center text-[15px] leading-normal text-g2-text">
              Hold steady. The host is taking the shot.
            </p>
            <button
              onClick={cleanupCameraStream}
              className="h-[52px] rounded-lg border border-white/15 text-white font-semibold text-[15px] cursor-pointer"
            >
              Stop sharing
            </button>
          </footer>
        </div>
      )}
      {selectedPhoto && (
        <PhotoLightbox
          photo={selectedPhoto}
          onClose={() => setSelectedPhoto(null)}
          sessionId={sessionId}
          isFavorite={favorites.includes(selectedPhoto.id)}
          onToggleFavorite={handleToggleFavorite}
          isHiddenLocally={hiddenIds.includes(selectedPhoto.id)}
          onToggleHideLocally={handleToggleHideLocally}
          isHost={isEventHost}
        />
      )}
    </EventContext.Provider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-g2-page text-g2-tertiary min-h-screen flex items-center justify-center font-sans text-sm px-6 text-center">
      {children}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import {
  Shield, Check, X, Camera, Info, QrCode, Sliders, Smartphone, Laptop,
  Battery, AlertCircle, Trash2, HelpCircle, ExternalLink, RefreshCw, ChevronDown, ChevronUp, Radio,
  Lock, Edit3, Save, CheckCircle2, UserX
} from 'lucide-react';
import {
  collection, query, where, onSnapshot, orderBy, doc, getDoc, setDoc, updateDoc, deleteDoc
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { Photo, GuestSession, EventSettings } from '../types';
import QRCode from 'qrcode';

interface HostDashboardProps {
  onLaunchSlideshow: () => void;
  onExit: () => void;
  sessionId: string;
  lensState: {
    activeRequester: string | null;
    status: 'idle' | 'invited' | 'connected' | 'flashing';
    liveViewfinderFrame: string | null;
    triggerRequested: boolean;
  };
  setLensState: React.Dispatch<React.SetStateAction<{
    activeRequester: string | null;
    status: 'idle' | 'invited' | 'connected' | 'flashing';
    liveViewfinderFrame: string | null;
    triggerRequested: boolean;
  }>>;
  isHost: boolean;
  setIsHost: (isHost: boolean) => void;
  eventSettings?: EventSettings;
}

export default function HostDashboard({
  onLaunchSlideshow,
  onExit,
  sessionId,
  lensState,
  setLensState,
  isHost,
  setIsHost,
  eventSettings,
}: HostDashboardProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [sessions, setSessions] = useState<GuestSession[]>([]);
  const [autoApproval, setAutoApproval] = useState(true);
  const [guestLensEnabled, setGuestLensEnabled] = useState(true);
  const [eventTitle, setEventTitle] = useState('Summer Gala 2026');
  const [eventSubtitle, setEventSubtitle] = useState('Tap any photo to react!');
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [savedMetadataSuccess, setSavedMetadataSuccess] = useState(false);

  // Security Lock state
  const [isUnlocked, setIsUnlocked] = useState(isHost);
  const [enteredPin, setEnteredPin] = useState('');
  const [pinError, setPinError] = useState('');

  const [openTipId, setOpenTipId] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  const joinLink = window.location.origin;

  // Sync isUnlocked when parent isHost changes
  useEffect(() => {
    setIsUnlocked(isHost);
  }, [isHost]);

  // Generate QR code on mount or when joinLink changes
  useEffect(() => {
    QRCode.toDataURL(joinLink, {
      margin: 2,
      width: 200,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    })
    .then(url => setQrDataUrl(url))
    .catch(err => console.error('Error generating QR code in HostDashboard:', err));
  }, [joinLink]);

  // 1. Listen for ALL photos in real time (for moderation)
  useEffect(() => {
    const q = query(collection(db, 'photos'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snap) => {
      const docs: Photo[] = [];
      snap.forEach((doc) => {
        docs.push({ id: doc.id, ...doc.data() } as Photo);
      });
      setPhotos(docs);
    }, (err) => {
      console.error('Error listening to photos:', err);
      handleFirestoreError(err, OperationType.LIST, 'photos');
    });

    return () => unsubscribe();
  }, []);

  // 2. Listen for registered Sessions (for Tripod devices and ad-hoc guest lenses)
  useEffect(() => {
    const q = query(collection(db, 'sessions'));
    const unsubscribe = onSnapshot(q, (snap) => {
      const docs: GuestSession[] = [];
      snap.forEach((doc) => {
        docs.push({ sessionId: doc.id, ...doc.data() } as GuestSession);
      });
      setSessions(docs);
    }, (err) => {
      console.error('Error listening to sessions:', err);
      handleFirestoreError(err, OperationType.LIST, 'sessions');
    });

    return () => unsubscribe();
  }, []);

  // 3. Listen to Event Settings document
  useEffect(() => {
    const docRef = doc(db, 'settings', 'event-settings');
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.autoApproval !== undefined) setAutoApproval(data.autoApproval);
        if (data.guestLensEnabled !== undefined) setGuestLensEnabled(data.guestLensEnabled);
        if (data.eventTitle) setEventTitle(data.eventTitle);
        if (data.eventSubtitle) setEventSubtitle(data.eventSubtitle);
      } else {
        // Bootstrap settings if not existing
        setDoc(docRef, {
          autoApproval: true,
          guestLensEnabled: true,
          eventTitle: 'Summer Gala 2026',
          eventSubtitle: 'Tap any photo to react!'
        }).catch((e) => {
          handleFirestoreError(e, OperationType.CREATE, 'settings/event-settings');
        });
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'settings/event-settings');
    });

    return () => unsubscribe();
  }, []);

  // Sync Host's local lensState based on active session's real-time changes
  useEffect(() => {
    if (!lensState.activeRequester) return;

    const activeGuest = sessions.find(s => s.sessionId === lensState.activeRequester);
    if (!activeGuest) {
      if (lensState.status !== 'idle') {
        setLensState(prev => ({ ...prev, status: 'idle', activeRequester: null, liveViewfinderFrame: null }));
      }
      return;
    }

    const currentStatus = activeGuest.lens_status || 'off';
    const currentFrame = activeGuest.stream_frame || null;

    // Map DB lens_status to local status
    const targetStatus = currentStatus === 'streaming' ? 'connected' : (currentStatus === 'requesting' ? 'invited' : 'idle');

    if (lensState.status !== targetStatus || lensState.liveViewfinderFrame !== currentFrame) {
      setLensState(prev => ({
        ...prev,
        status: targetStatus,
        liveViewfinderFrame: currentFrame,
        activeRequester: targetStatus === 'idle' ? null : prev.activeRequester
      }));
    }
  }, [sessions, lensState.activeRequester]);

  // Handle local shutter button clicks by writing trigger_shutter to Firestore
  useEffect(() => {
    if (lensState.triggerRequested && lensState.activeRequester) {
      const targetSessionId = lensState.activeRequester;
      const docRef = doc(db, 'sessions', targetSessionId);
      updateDoc(docRef, { trigger_shutter: true })
        .then(() => {
          setLensState(prev => ({ ...prev, triggerRequested: false }));
        })
        .catch((e) => {
          console.error('Failed to trigger remote shutter:', e);
          setLensState(prev => ({ ...prev, triggerRequested: false }));
        });
    }
  }, [lensState.triggerRequested, lensState.activeRequester]);

  // Save Event Metadata (Title and Subtitle)
  const handleSaveMetadata = async () => {
    try {
      setSavingMetadata(true);
      const docRef = doc(db, 'settings', 'event-settings');
      await updateDoc(docRef, {
        eventTitle,
        eventSubtitle
      });
      setSavingMetadata(false);
      setSavedMetadataSuccess(true);
      setTimeout(() => setSavedMetadataSuccess(false), 3000);
    } catch (e) {
      console.error('Failed to save metadata:', e);
      setSavingMetadata(false);
      handleFirestoreError(e, OperationType.UPDATE, 'settings/event-settings');
    }
  };

  // Toggle Allow Guest Lens Requests
  const handleToggleGuestLens = async () => {
    try {
      const nextVal = !guestLensEnabled;
      setGuestLensEnabled(nextVal);
      const docRef = doc(db, 'settings', 'event-settings');
      await updateDoc(docRef, { guestLensEnabled: nextVal });
    } catch (e) {
      console.error('Failed to update guest lens setting:', e);
      handleFirestoreError(e, OperationType.UPDATE, 'settings/event-settings');
    }
  };

  // Bulk Delete Pending Photos
  const handleDeleteAllPending = async () => {
    const pendingList = photos.filter((p) => p.status === 'pending');
    if (pendingList.length === 0) return;

    if (!window.confirm(`Host God-Mode: Permanently delete all ${pendingList.length} pending photos?`)) return;

    try {
      await Promise.all(pendingList.map((p) => deleteDoc(doc(db, 'photos', p.id))));
    } catch (e) {
      console.error('Failed bulk delete pending photos:', e);
      handleFirestoreError(e, OperationType.DELETE, 'photos');
    }
  };

  // Bulk Clear Flagged Photos
  const handleClearAllFlagged = async () => {
    const flaggedList = photos.filter((p) => p.flagged === true && p.status !== 'rejected');
    if (flaggedList.length === 0) return;

    if (!window.confirm(`Host God-Mode: Permanently delete all ${flaggedList.length} flagged photos from the event?`)) return;

    try {
      await Promise.all(flaggedList.map((p) => deleteDoc(doc(db, 'photos', p.id))));
    } catch (e) {
      console.error('Failed bulk clear flagged photos:', e);
      handleFirestoreError(e, OperationType.DELETE, 'photos');
    }
  };

  // Prune Stale Guest Sessions (>15 mins inactive)
  const handlePruneStaleSessions = async () => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    const staleSessions = sessions.filter((s) => !s.lastActive || s.lastActive < cutoff);

    if (staleSessions.length === 0) {
      alert('No stale guest sessions found (all active within 15 minutes).');
      return;
    }

    if (!window.confirm(`Prune ${staleSessions.length} inactive guest sessions (older than 15 minutes)?`)) return;

    try {
      await Promise.all(staleSessions.map((s) => deleteDoc(doc(db, 'sessions', s.sessionId))));
      alert(`Successfully pruned ${staleSessions.length} stale sessions.`);
    } catch (e) {
      console.error('Failed pruning stale sessions:', e);
      handleFirestoreError(e, OperationType.DELETE, 'sessions');
    }
  };

  // Kick / Remove specific guest session
  const handleKickGuestSession = async (guestSessionId: string, guestNickname: string) => {
    if (!window.confirm(`Remove session for "${guestNickname}"? They will need to rejoin.`)) return;

    try {
      await deleteDoc(doc(db, 'sessions', guestSessionId));
    } catch (e) {
      console.error('Failed kicking guest session:', e);
      handleFirestoreError(e, OperationType.DELETE, `sessions/${guestSessionId}`);
    }
  };

  // PIN Unlock and Lock handlers
  const handleUnlockWithPin = (e: React.FormEvent) => {
    e.preventDefault();
    if (enteredPin === '1234') {
      setIsUnlocked(true);
      setIsHost(true);
      setPinError('');
      setEnteredPin('');
    } else {
      setPinError('Incorrect PIN. Default is 1234.');
    }
  };

  const handleLockHostPanel = () => {
    setIsUnlocked(false);
    setIsHost(false);
    setEnteredPin('');
    setPinError('');
  };

  // Toggle moderation autoApproval
  const handleToggleAutoApproval = async () => {
    try {
      const nextVal = !autoApproval;
      setAutoApproval(nextVal);
      const docRef = doc(db, 'settings', 'event-settings');
      await updateDoc(docRef, { autoApproval: nextVal });
    } catch (e) {
      console.error('Failed to update approval setting:', e);
      handleFirestoreError(e, OperationType.UPDATE, 'settings/event-settings');
    }
  };

  const handleApprovePhoto = async (id: string) => {
    try {
      const docRef = doc(db, 'photos', id);
      await updateDoc(docRef, { status: 'approved' });
    } catch (e) {
      console.error('Approve failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, `photos/${id}`);
    }
  };

  const handleRejectPhoto = async (id: string) => {
    try {
      const docRef = doc(db, 'photos', id);
      await updateDoc(docRef, { status: 'rejected' });
    } catch (e) {
      console.error('Reject failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, `photos/${id}`);
    }
  };

  const handleDeletePhoto = async (id: string) => {
    if (!window.confirm('Are you sure you want to permanently delete this photo?')) return;
    try {
      await deleteDoc(doc(db, 'photos', id));
    } catch (e) {
      console.error('Delete failed:', e);
      handleFirestoreError(e, OperationType.DELETE, `photos/${id}`);
    }
  };

  // Remote Tripod shutter triggers
  const handleTriggerTripodShutter = async (tripodSessionId: string) => {
    try {
      const docRef = doc(db, 'sessions', tripodSessionId);
      await updateDoc(docRef, { trigger_shutter: true });
    } catch (e) {
      console.error('Tripod shutter trigger failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, `sessions/${tripodSessionId}`);
    }
  };

  // Ad-Hoc Guest Lens invitation trigger
  const handleRequestLens = async (guestSessionId: string) => {
    try {
      const docRef = doc(db, 'sessions', guestSessionId);
      await updateDoc(docRef, {
        invited_to_lens: true,
        lens_status: 'requesting',
      });
      setLensState(prev => ({
        ...prev,
        activeRequester: guestSessionId,
        status: 'invited'
      }));
    } catch (e) {
      console.error('Lens invitation failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, `sessions/${guestSessionId}`);
    }
  };

  const handleCancelLens = async (guestSessionId: string) => {
    try {
      const docRef = doc(db, 'sessions', guestSessionId);
      await updateDoc(docRef, {
        invited_to_lens: false,
        lens_status: 'off',
        stream_frame: null,
      });
      setLensState(prev => ({
        ...prev,
        activeRequester: null,
        status: 'idle',
        liveViewfinderFrame: null
      }));
    } catch (e) {
      console.error('Cancel lens failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, `sessions/${guestSessionId}`);
    }
  };

  const handleTriggerLensShutter = async (guestSessionId: string) => {
    try {
      const docRef = doc(db, 'sessions', guestSessionId);
      await updateDoc(docRef, { trigger_shutter: true });
    } catch (e) {
      console.error('Lens trigger shutter failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, `sessions/${guestSessionId}`);
    }
  };

  const toggleTip = (id: string) => {
    setOpenTipId(openTipId === id ? null : id);
  };

  const pendingPhotos = photos.filter((p) => p.status === 'pending');
  const flaggedPhotos = photos.filter((p) => p.flagged === true && p.status !== 'rejected');
  const tripods = sessions.filter((s) => s.role === 'tripod');
  const activeGuests = sessions.filter((s) => s.role === 'guest' && s.sessionId !== sessionId);

  if (!isUnlocked) {
    return (
      <div className="min-h-screen bg-[#050505] text-slate-100 font-sans flex items-center justify-center p-4">
        <div className="w-full max-w-md glass-card border border-white/10 rounded-3xl p-8 space-y-6 text-center shadow-2xl relative overflow-hidden">
          <div className="w-16 h-16 bg-[#00f2ff]/10 border border-[#00f2ff]/30 text-[#00f2ff] rounded-2xl flex items-center justify-center mx-auto shadow-[0_0_15px_rgba(0,242,255,0.15)]">
            <Lock className="w-8 h-8" />
          </div>

          <div className="space-y-2">
            <h2 className="text-xl font-extrabold text-white">Host Security Lock</h2>
            <p className="text-xs text-slate-400">
              Enter 4-digit PIN to access Event Control & Moderation Panel.
            </p>
            <p className="text-[10px] text-[#00f2ff] font-mono bg-[#00f2ff]/5 border border-[#00f2ff]/20 py-1 px-3 rounded-lg inline-block">
              Default Host PIN: <span className="font-bold">1234</span>
            </p>
          </div>

          <form onSubmit={handleUnlockWithPin} className="space-y-4">
            <div>
              <input
                type="password"
                maxLength={4}
                value={enteredPin}
                onChange={(e) => {
                  setEnteredPin(e.target.value);
                  setPinError('');
                }}
                placeholder="••••"
                className="w-48 mx-auto text-center text-3xl font-mono tracking-[0.5em] bg-black/60 border border-white/10 rounded-2xl py-3 px-4 text-white focus:outline-none focus:border-[#00f2ff] transition-all"
                autoFocus
              />
              {pinError && (
                <p className="text-xs text-red-400 font-bold mt-2 animate-bounce">
                  {pinError}
                </p>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onExit}
                className="flex-1 py-3 px-4 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                Cancel / Exit
              </button>
              <button
                type="submit"
                className="flex-1 py-3 px-4 bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-extrabold rounded-xl text-xs shadow-lg shadow-[#00f2ff]/20 transition-all cursor-pointer"
              >
                Unlock Panel
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-slate-100 font-sans p-4 md:p-8">
      {/* Container */}
      <div className="max-w-6xl mx-auto space-y-8 pb-12">
        {/* Header Console */}
        <header className="flex flex-col md:flex-row md:justify-between md:items-center gap-4 glass-card neon-border p-6 rounded-2xl shadow-xl">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-[#00f2ff]/5 border border-[#00f2ff]/20 text-[#00f2ff] rounded-xl shadow-[0_0_10px_rgba(0,242,255,0.1)]">
              <Shield className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <h1 className="text-xl font-extrabold text-white">Event Control Panel</h1>
              <p className="text-xs text-slate-400">Live monitoring, stationary tripods, and guest lens handshakes</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleLockHostPanel}
              className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-bold px-3.5 py-2.5 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition-all duration-300"
              title="Lock Host Panel"
            >
              <Lock className="w-4 h-4" /> Lock Host Panel
            </button>
            <button
              onClick={onLaunchSlideshow}
              className="bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-bold px-4 py-2.5 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-[#00f2ff]/10 transition-all duration-300"
            >
              <Radio className="w-4 h-4" /> Launch Slideshow
            </button>
            <button
              onClick={onExit}
              className="bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 font-semibold px-4 py-2.5 rounded-xl text-xs cursor-pointer transition-all duration-300"
            >
              Back to Gallery
            </button>
          </div>
        </header>

        {/* Dashboard Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Column 1: Metadata, Governance Switches, Proximity Sharing & QR */}
          <div className="space-y-6 lg:col-span-1">
            {/* Event Metadata Settings Card */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-400 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Edit3 className="w-4 h-4 text-[#00f2ff]" /> Event Details & Title
                </span>
                {savedMetadataSuccess && (
                  <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                    <CheckCircle2 className="w-3 h-3" /> Saved Live!
                  </span>
                )}
              </h3>

              <div className="space-y-3 text-left">
                <div>
                  <label className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block mb-1">
                    Event Title
                  </label>
                  <input
                    type="text"
                    value={eventTitle}
                    onChange={(e) => setEventTitle(e.target.value)}
                    placeholder="e.g. Summer Gala 2026"
                    className="w-full bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#00f2ff] transition-all"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block mb-1">
                    Welcome Subtitle / Announcement
                  </label>
                  <input
                    type="text"
                    value={eventSubtitle}
                    onChange={(e) => setEventSubtitle(e.target.value)}
                    placeholder="e.g. Tap any photo to react!"
                    className="w-full bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-[#00f2ff] transition-all"
                  />
                </div>

                <button
                  onClick={handleSaveMetadata}
                  disabled={savingMetadata}
                  className="w-full bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-extrabold py-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-[#00f2ff]/20 transition-all"
                >
                  <Save className="w-4 h-4" />
                  {savingMetadata ? 'Saving Details...' : 'Save Metadata to Live Guests'}
                </button>
              </div>
            </div>

            {/* Moderation & Governance Switches */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Sliders className="w-4 h-4 text-[#00f2ff]" /> Moderation & Governance
              </h3>
              
              <div className="space-y-3">
                {/* Auto Approval Mode Switch */}
                <div className="flex items-center justify-between p-3.5 bg-black/40 border border-white/5 rounded-xl">
                  <div>
                    <p className="text-xs font-bold text-white">Auto-Approval Mode</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">Snaps publish without manual review</p>
                  </div>
                  <button
                    onClick={handleToggleAutoApproval}
                    className={`w-12 h-6.5 rounded-full p-0.5 transition-colors cursor-pointer relative ${
                      autoApproval ? 'bg-[#00f2ff]' : 'bg-white/10'
                    }`}
                  >
                    <div
                      className={`w-5.5 h-5.5 bg-white rounded-full shadow-md transform transition-transform ${
                        autoApproval ? 'translate-x-5.5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Allow Guest Lens Requests Switch */}
                <div className="flex items-center justify-between p-3.5 bg-black/40 border border-white/5 rounded-xl">
                  <div>
                    <p className="text-xs font-bold text-white">Allow Guest Lens Requests</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">Permit ad-hoc guest lens handshakes</p>
                  </div>
                  <button
                    onClick={handleToggleGuestLens}
                    className={`w-12 h-6.5 rounded-full p-0.5 transition-colors cursor-pointer relative ${
                      guestLensEnabled ? 'bg-[#00f2ff]' : 'bg-white/10'
                    }`}
                  >
                    <div
                      className={`w-5.5 h-5.5 bg-white rounded-full shadow-md transform transition-transform ${
                        guestLensEnabled ? 'translate-x-5.5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            {/* Event QR Code Card */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg text-center space-y-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-400 flex items-center justify-center gap-1.5">
                <QrCode className="w-4 h-4 text-[#00f2ff]" /> Share Event QR
              </h3>
              <div className="w-40 h-40 bg-white p-2.5 rounded-2xl mx-auto flex items-center justify-center shadow-lg border border-slate-800">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Scan to join Get2Share"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="w-full h-full bg-slate-100 animate-pulse rounded-lg" />
                )}
              </div>
              <div className="space-y-1">
                <p className="text-xs font-bold text-slate-200">Universal Event Link</p>
                <div className="bg-black/40 px-3 py-2 rounded-xl text-xs font-mono text-[#00f2ff] break-all border border-white/5 flex items-center justify-between gap-2">
                  <span className="truncate">{joinLink}</span>
                  <a href={joinLink} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-white shrink-0">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>

            {/* Proximity Onboarding Cards */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Smartphone className="w-4 h-4 text-[#00f2ff]" /> Proximity Deployment Tips
              </h3>

              <div className="space-y-2.5">
                {/* NFC Coasters */}
                <div className="border border-white/5 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleTip('nfc')}
                    className="w-full bg-black/20 hover:bg-black/40 p-3 flex justify-between items-center text-xs font-bold text-slate-300 cursor-pointer"
                  >
                    <span>🎯 NFC Table Coasters Setup</span>
                    {openTipId === 'nfc' ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                  </button>
                  {openTipId === 'nfc' && (
                    <div className="p-3.5 bg-black/40 text-[11px] text-slate-400 leading-relaxed border-t border-white/5 space-y-1.5">
                      <p>Program inexpensive NFC tags ($0.30 each) using the free <strong>NFC Tools</strong> app on your smartphone.</p>
                      <p className="text-slate-500">Write a URL record pointing to: <span className="text-[#00f2ff] font-mono">{joinLink}</span></p>
                      <p>Stick them underneath bar mats or drink coasters. Guests tap their phones on the coaster and instantly join without typing code!</p>
                    </div>
                  )}
                </div>

                {/* Captive Wi-Fi Router Portal */}
                <div className="border border-white/5 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleTip('wifi')}
                    className="w-full bg-black/20 hover:bg-black/40 p-3 flex justify-between items-center text-xs font-bold text-slate-300 cursor-pointer"
                  >
                    <span>📶 Captive Wi-Fi Portal Guidelines</span>
                    {openTipId === 'wifi' ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                  </button>
                  {openTipId === 'wifi' && (
                    <div className="p-3.5 bg-black/40 text-[11px] text-slate-400 leading-relaxed border-t border-white/5 space-y-1.5">
                      <p>You can force-open the event web app when guests connect to the venue router's guest Wi-Fi.</p>
                      <p>In your router settings, configure the <strong>Splash/Landing Page redirect</strong> to target: <span className="text-[#00f2ff] font-mono">{joinLink}</span></p>
                      <p>Once connected, iOS & Android natively trigger a sliding viewport showing your event page instantly.</p>
                    </div>
                  )}
                </div>

                {/* Native Calendar Geofence */}
                <div className="border border-white/5 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleTip('calendar')}
                    className="w-full bg-black/20 hover:bg-black/40 p-3 flex justify-between items-center text-xs font-bold text-slate-300 cursor-pointer"
                  >
                    <span>📅 Proximity Calendar Alerts</span>
                    {openTipId === 'calendar' ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                  </button>
                  {openTipId === 'calendar' && (
                    <div className="p-3.5 bg-black/40 text-[11px] text-slate-400 leading-relaxed border-t border-white/5 space-y-1.5">
                      <p>Send calendar invitations (`.ics` files) containing the venue location address and notes field notes.</p>
                      <p>Add the event URL link in the description. When guests step within the geofence perimeter of the coordinates, iOS and Android automatically deliver an arrival push alert linking straight to the web app!</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Column 2 & 3: Active Moderation, Tripod feeds, Handshakes */}
          <div className="lg:col-span-2 space-y-6">
            {/* Multi-Tripod Views and Shutter Controls */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-400 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Laptop className="w-4 h-4 text-[#00f2ff]" /> Active Tripods ({tripods.length})
                </span>
                <span className="text-[10px] text-slate-500 font-medium">Any spare device on a stand</span>
              </h3>

              {tripods.length === 0 ? (
                <div className="p-6 bg-black/30 border border-white/5 rounded-xl text-center text-slate-500 text-xs">
                  No stationary Tripods registered. Setup a spare phone in Tripod Mode to trigger high-res remote captures!
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {tripods.map((tripod) => (
                    <div key={tripod.sessionId} className="bg-black/30 border border-white/5 rounded-xl overflow-hidden flex flex-col justify-between">
                      {/* Viewfinder Thumbnail */}
                      <div className="bg-black/40 aspect-video relative flex items-center justify-center border-b border-white/5">
                        {tripod.stream_frame ? (
                          <img
                            src={tripod.stream_frame}
                            alt="Tripod Live"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="text-center p-4">
                            <Radio className="w-6 h-6 text-slate-600 animate-ping mx-auto mb-1" />
                            <p className="text-[10px] text-slate-600">Idle Viewfinder Stream</p>
                          </div>
                        )}
                        <span className="absolute top-2 left-2 text-[10px] font-bold bg-black/60 backdrop-blur-md text-[#00f2ff] px-2 py-0.5 rounded-full border border-[#00f2ff]/20">
                          {tripod.nickname}
                        </span>
                        <div className="absolute top-2 right-2 flex items-center gap-1.5 text-[10px] bg-black/60 px-2 py-0.5 rounded-full">
                          <Battery className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-slate-300">{tripod.deviceInfo?.batteryLevel || 100}%</span>
                        </div>
                      </div>

                      <div className="p-3.5 bg-black/40 flex justify-between items-center">
                        <span className="text-[10px] text-slate-500 font-mono">
                          Ready &bull; remote trigger
                        </span>
                        <button
                          onClick={() => handleTriggerTripodShutter(tripod.sessionId)}
                          className="bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-extrabold px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition-all duration-300 shadow-md shadow-[#00f2ff]/20"
                        >
                          <Camera className="w-3.5 h-3.5" /> Trigger Shutter
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Tap-to-Acquire Guest Handshakes ( Sara's Active Lens ) */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Smartphone className="w-4 h-4 text-[#00f2ff]" /> Tap-to-Acquire Guest Lens
                </h3>
                <div className="flex items-center gap-2">
                  {!guestLensEnabled && (
                    <span className="text-[10px] bg-red-950/80 border border-red-800/40 text-red-400 font-bold px-2.5 py-0.5 rounded-full">
                      Disabled by Host
                    </span>
                  )}
                  <button
                    onClick={handlePruneStaleSessions}
                    className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 font-bold px-2.5 py-1 rounded-lg flex items-center gap-1 cursor-pointer transition-colors"
                    title="Remove sessions inactive for >15 minutes"
                  >
                    <UserX className="w-3 h-3 text-red-400" /> Prune Stale (&gt;15m)
                  </button>
                </div>
              </div>

              {/* LIVE PREVIEW VIEWFINDER CARD */}
              {lensState.status === 'connected' && (
                <div className="bg-[#0B0F19] border border-gray-800 p-4 rounded-xl flex flex-col md:flex-row items-center gap-4 justify-between">
                  <div className="flex items-center gap-3">
                    {/* Streaming Thumbnail Mirror */}
                    <div className="w-24 h-24 bg-black rounded-xl overflow-hidden border border-white/10 flex items-center justify-center relative">
                      {lensState.liveViewfinderFrame ? (
                        <img src={lensState.liveViewfinderFrame} alt="Live View" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[10px] text-gray-500 animate-pulse">Waiting for feed...</span>
                      )}
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-cyan-400 flex items-center gap-1">
                        <span className="w-2 h-2 bg-red-600 rounded-full animate-ping"></span> Live Handshake Active
                      </h4>
                      <p className="text-[10px] text-gray-400">Viewing remote lens preview. Tap shutter below to snap.</p>
                    </div>
                  </div>

                  {/* Shutter Trigger Button */}
                  <button
                    onClick={() => setLensState(prev => ({ ...prev, triggerRequested: true }))}
                    className="bg-cyan-400 hover:bg-cyan-300 text-black font-black text-xs py-2.5 px-5 rounded-xl transition duration-150 active:scale-95 flex items-center gap-2 cursor-pointer"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    Trigger Remote Shutter
                  </button>
                </div>
              )}

              {activeGuests.length === 0 ? (
                <div className="p-6 bg-black/30 border border-white/5 rounded-xl text-center text-slate-500 text-xs">
                  No active guest devices detected on location to request ad-hoc lenses.
                </div>
              ) : (
                <div className="space-y-3">
                  {activeGuests.map((guest) => {
                    const isRequesting = guest.lens_status === 'requesting';
                    const isStreaming = guest.lens_status === 'streaming';
                    const hasDeclined = guest.lens_status === 'declined';

                    return (
                      <div key={guest.sessionId} className="bg-black/30 border border-white/5 p-4 rounded-xl flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 bg-black/50 border border-white/5 rounded-lg flex items-center justify-center font-bold text-slate-300 text-sm">
                            {guest.nickname.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="text-xs font-bold text-white flex items-center gap-2">
                              {guest.nickname}
                              <button
                                onClick={() => handleKickGuestSession(guest.sessionId, guest.nickname)}
                                className="p-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-md text-[10px] font-bold transition-colors cursor-pointer"
                                title="Kick / Remove Guest Session"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </p>
                            <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                              Active: {new Date(guest.lastActive).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </p>
                          </div>
                        </div>

                        {/* Stream Preview if active */}
                        {isStreaming && guest.stream_frame && (
                          <div className="w-32 aspect-video bg-black/40 rounded-lg border border-white/5 overflow-hidden relative">
                            <img src={guest.stream_frame} alt="Preview" className="w-full h-full object-cover" />
                            <span className="absolute bottom-1 right-1 bg-red-600 w-1.5 h-1.5 rounded-full animate-ping" />
                          </div>
                        )}

                        <div className="flex items-center gap-2 shrink-0">
                          {isRequesting && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-slate-400 animate-pulse">Awaiting acceptance...</span>
                              <button
                                onClick={() => handleCancelLens(guest.sessionId)}
                                className="bg-white/5 hover:bg-white/10 text-slate-400 font-bold px-3 py-1.5 rounded-lg text-[10px] cursor-pointer transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          )}

                          {isStreaming && (
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleTriggerLensShutter(guest.sessionId)}
                                className="bg-red-500 hover:bg-red-400 text-white font-extrabold px-3 py-1.5 rounded-lg text-xs flex items-center gap-1 cursor-pointer transition-all shadow-md shadow-red-500/10"
                              >
                                <Camera className="w-3.5 h-3.5" /> Shutter
                              </button>
                              <button
                                onClick={() => handleCancelLens(guest.sessionId)}
                                className="bg-white/5 hover:bg-white/10 text-slate-400 px-2.5 py-1.5 rounded-lg text-[10px] cursor-pointer"
                              >
                                Disconnect
                              </button>
                            </div>
                          )}

                          {hasDeclined && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-red-400 font-bold flex items-center gap-1">
                                <X className="w-3.5 h-3.5" /> Declined
                              </span>
                              <button
                                onClick={() => handleRequestLens(guest.sessionId)}
                                disabled={!guestLensEnabled}
                                className="bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 font-bold px-3 py-1.5 rounded-lg text-[10px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                Retry Handshake
                              </button>
                            </div>
                          )}

                          {(!guest.lens_status || guest.lens_status === 'off') && (
                            <button
                              onClick={() => handleRequestLens(guest.sessionId)}
                              disabled={!guestLensEnabled}
                              className="bg-white/5 border border-white/10 hover:bg-[#00f2ff] hover:text-slate-950 text-[#00f2ff] font-bold px-3.5 py-2 rounded-xl text-xs transition-all duration-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              📸 Request Lens Handshake
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Manual Moderation Queue & Flagged Items */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-5">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Shield className="w-4 h-4 text-[#00f2ff]" /> Moderation Queue ({pendingPhotos.length + flaggedPhotos.length})
                </h3>
                
                <div className="flex items-center gap-2">
                  {flaggedPhotos.length > 0 && (
                    <button
                      onClick={handleClearAllFlagged}
                      className="text-[10px] bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2.5 py-1 rounded-lg font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Trash2 className="w-3 h-3" /> Clear All Flagged ({flaggedPhotos.length})
                    </button>
                  )}
                  {pendingPhotos.length > 0 && (
                    <button
                      onClick={handleDeleteAllPending}
                      className="text-[10px] bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 px-2.5 py-1 rounded-lg font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Trash2 className="w-3 h-3" /> Delete All Pending ({pendingPhotos.length})
                    </button>
                  )}
                </div>
              </div>

              {pendingPhotos.length === 0 && flaggedPhotos.length === 0 ? (
                <div className="p-6 bg-black/30 border border-white/5 rounded-xl text-center text-slate-500 text-xs">
                  All snaps cleared! Moderation queue is pristine.
                </div>
              ) : (
                <div className="space-y-4 max-h-[450px] overflow-y-auto pr-1">
                  {/* Flagged Snaps First */}
                  {flaggedPhotos.map((photo) => (
                    <div key={photo.id} className="bg-amber-950/20 border border-amber-900/40 p-4 rounded-xl flex gap-4 items-center justify-between">
                      <div className="flex items-center gap-3">
                        <img src={photo.url} alt="Flagged" className="w-16 h-16 object-cover rounded-lg border border-amber-900/30" />
                        <div>
                          <div className="flex items-center gap-1.5 text-xs text-amber-400 font-bold">
                            <AlertCircle className="w-4 h-4 shrink-0" /> Flagged by Guest
                          </div>
                          <p className="text-xs font-bold text-slate-200 mt-1">Uploader: {photo.nickname}</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDeletePhoto(photo.id)}
                          className="bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-400 font-bold p-2.5 rounded-xl text-xs cursor-pointer transition-colors"
                          title="Permanently Delete Photo (God-Mode)"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleRejectPhoto(photo.id)}
                          className="bg-white/5 hover:bg-red-500/10 hover:text-red-400 border border-white/10 text-slate-400 p-2.5 rounded-xl text-xs cursor-pointer transition-colors"
                          title="Reject Content"
                        >
                          <X className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleApprovePhoto(photo.id)}
                          className="bg-emerald-500/25 hover:bg-emerald-500/35 border border-emerald-500/30 text-emerald-400 font-bold p-2.5 rounded-xl text-xs cursor-pointer"
                          title="Dismiss Flag & Approve"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Standard Pending Snaps */}
                  {pendingPhotos.map((photo) => (
                    <div key={photo.id} className="bg-black/30 border border-white/5 p-4 rounded-xl flex gap-4 items-center justify-between">
                      <div className="flex items-center gap-3">
                        <img src={photo.url} alt="Pending" className="w-16 h-16 object-cover rounded-lg" />
                        <div>
                          <p className="text-xs font-bold text-white">Uploader: {photo.nickname}</p>
                          <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                            Uploaded at: {new Date(photo.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDeletePhoto(photo.id)}
                          className="bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-400 font-bold p-2.5 rounded-xl text-xs cursor-pointer transition-colors"
                          title="Permanently Delete Photo (God-Mode)"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleRejectPhoto(photo.id)}
                          className="bg-white/5 hover:bg-red-500/10 hover:text-red-400 border border-white/10 text-slate-400 p-2.5 rounded-xl text-xs cursor-pointer transition-colors"
                          title="Reject"
                        >
                          <X className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleApprovePhoto(photo.id)}
                          className="bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-extrabold p-2.5 rounded-xl text-xs cursor-pointer transition-all duration-300 shadow-md shadow-[#00f2ff]/20"
                          title="Approve"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

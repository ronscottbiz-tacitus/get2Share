import React, { useEffect, useState } from 'react';
import {
  Shield, Check, X, Camera, Info, QrCode, Sliders, Smartphone, Laptop,
  Battery, AlertCircle, Trash2, HelpCircle, ExternalLink, RefreshCw, ChevronDown, ChevronUp, Radio,
  Lock, Edit3, Save, CheckCircle2, UserX
} from 'lucide-react';
import {
  collection, query, onSnapshot, doc, setDoc, updateDoc, deleteDoc, serverTimestamp
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { Photo, GuestSession } from '../types';
import QRCode from 'qrcode';
import Get2ShareLockup from './Get2ShareLockup';
import { useRemoteShutter } from './useRemoteShutter';
import { ShutterButton, ShotOverlay, shotStatusText } from './ShutterButton';
import AddShareSpot from './AddShareSpot';

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
  signedInEmail: string | null;
  authError: string;
  onHostSignIn: () => void;
  onHostSignOut: () => void;
}

export default function HostDashboard({
  onLaunchSlideshow,
  onExit,
  sessionId,
  lensState,
  setLensState,
  isHost,
  signedInEmail,
  authError,
  onHostSignIn,
  onHostSignOut,
}: HostDashboardProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [sessions, setSessions] = useState<GuestSession[]>([]);
  const [autoApproval, setAutoApproval] = useState(true);
  const [guestLensEnabled, setGuestLensEnabled] = useState(true);
  const [eventTitle, setEventTitle] = useState('Summer Gala 2026');
  const [eventSubtitle, setEventSubtitle] = useState('Tap any photo to react!');
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [savedMetadataSuccess, setSavedMetadataSuccess] = useState(false);

  const [openTipId, setOpenTipId] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  const joinLink = window.location.origin;

  // Remote "Take photo": tracks each shot from tap → device heard it → photo landed.
  const { shots, fire: fireShutter } = useRemoteShutter(sessions, photos);

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

  // 1. Listen for ALL photos in real time (for moderation) — host only
  useEffect(() => {
    if (!isHost) return;
    const q = query(collection(db, 'photos'));
    const unsubscribe = onSnapshot(q, (snap) => {
      const docs: Photo[] = [];
      snap.forEach((doc) => {
        docs.push({ id: doc.id, ...doc.data() } as Photo);
      });
      docs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setPhotos(docs);
    }, (err) => {
      console.error('Error listening to photos:', err);
    });

    return () => unsubscribe();
  }, [isHost]);

  // 2. Listen for registered Sessions (for Tripod devices and ad-hoc guest lenses) — host only
  useEffect(() => {
    if (!isHost) return;
    const q = query(collection(db, 'sessions'));
    const unsubscribe = onSnapshot(q, (snap) => {
      const docs: GuestSession[] = [];
      snap.forEach((doc) => {
        docs.push({ sessionId: doc.id, ...doc.data() } as GuestSession);
      });
      setSessions(docs);
    }, (err) => {
      console.error('Error listening to sessions:', err);
    });

    return () => unsubscribe();
  }, [isHost]);

  // 3. Listen to Event Settings document — host only (bootstraps it if missing)
  useEffect(() => {
    if (!isHost) return;
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
          console.error('Failed to create event settings:', e);
        });
      }
    }, (err) => {
      console.error('Error listening to event settings:', err);
    });

    return () => unsubscribe();
  }, [isHost]);

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
      updateDoc(docRef, { trigger_shutter: true, last_trigger_at: serverTimestamp() })
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

    if (!window.confirm(`Delete all ${pendingList.length} photos waiting for review?`)) return;

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

    if (!window.confirm(`Delete all ${flaggedList.length} reported photos from the event?`)) return;

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
      alert('Everyone has been active in the last 15 minutes.');
      return;
    }

    if (!window.confirm(`Remove ${staleSessions.length} guests who haven't been active for 15+ minutes?`)) return;

    try {
      await Promise.all(staleSessions.map((s) => deleteDoc(doc(db, 'sessions', s.sessionId))));
      alert(`Removed ${staleSessions.length} inactive guests.`);
    } catch (e) {
      console.error('Failed pruning stale sessions:', e);
      handleFirestoreError(e, OperationType.DELETE, 'sessions');
    }
  };

  // Kick / Remove specific guest session
  const handleKickGuestSession = async (guestSessionId: string, guestNickname: string) => {
    if (!window.confirm(`Remove ${guestNickname} from the event? They'll need to rejoin.`)) return;

    try {
      await deleteDoc(doc(db, 'sessions', guestSessionId));
    } catch (e) {
      console.error('Failed kicking guest session:', e);
      handleFirestoreError(e, OperationType.DELETE, `sessions/${guestSessionId}`);
    }
  };

  // Lock = sign the host out (the device drops back to an anonymous guest identity)
  const handleLockHostPanel = () => {
    onHostSignOut();
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
    if (!window.confirm('Delete this photo for everyone?')) return;
    try {
      await deleteDoc(doc(db, 'photos', id));
    } catch (e) {
      console.error('Delete failed:', e);
      handleFirestoreError(e, OperationType.DELETE, `photos/${id}`);
    }
  };

  // Remove a Share Spot. Deleting its pairing code means that device can't
  // reconnect as a Share Spot without a new code.
  const handleRemoveShareSpot = async (spot: GuestSession) => {
    if (!window.confirm(`Remove the Share Spot "${spot.nickname}"? That device will need a new code to reconnect.`)) return;
    try {
      if (spot.pairing_code) await deleteDoc(doc(db, 'spotPairings', spot.pairing_code));
      await deleteDoc(doc(db, 'sessions', spot.sessionId));
    } catch (e) {
      console.error('Remove Share Spot failed:', e);
      handleFirestoreError(e, OperationType.DELETE, `sessions/${spot.sessionId}`);
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

  const toggleTip = (id: string) => {
    setOpenTipId(openTipId === id ? null : id);
  };

  const pendingPhotos = photos.filter((p) => p.status === 'pending');
  const flaggedPhotos = photos.filter((p) => p.flagged === true && p.status !== 'rejected');
  const tripods = sessions.filter((s) => s.role === 'tripod');
  const activeGuests = sessions.filter((s) => s.role === 'guest' && s.sessionId !== sessionId);

  if (!isHost) {
    return (
      <div className="min-h-screen bg-g2-page text-g2-text font-sans flex items-center justify-center p-4">
        <div className="w-full max-w-md glass-card border border-white/10 rounded-3xl p-8 space-y-6 text-center shadow-2xl relative overflow-hidden">
          <div className="w-16 h-16 bg-g2-blue/10 border border-g2-blue/30 text-g2-blue-light rounded-2xl flex items-center justify-center mx-auto shadow-[0_0_15px_rgba(0,82,255,0.15)]">
            <Lock className="w-8 h-8" />
          </div>

          <div className="space-y-2">
            <h2 className="font-expanded font-black text-xl text-white">Host sign-in</h2>
            <p className="text-xs text-g2-tertiary">
              Sign in with the organizer's Google account to open Event Control & Moderation.
            </p>
            {signedInEmail && (
              <p className="text-[11px] text-amber-300">
                Signed in as {signedInEmail}, which is not a host account.
              </p>
            )}
          </div>

          {authError && (
            <p className="text-xs text-red-400 font-bold">{authError}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onExit}
              className="flex-1 py-3 px-4 bg-white/5 hover:bg-white/10 border border-white/10 text-g2-secondary font-bold rounded-xl text-xs transition-colors cursor-pointer"
            >
              Cancel / Exit
            </button>
            <button
              type="button"
              onClick={onHostSignIn}
              className="flex-1 py-3 px-4 bg-g2-blue hover:bg-g2-blue-hover text-white font-extrabold rounded-xl text-xs shadow-lg shadow-g2-blue/20 transition-all cursor-pointer"
            >
              Sign in with Google
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-g2-page text-g2-text font-sans p-4 md:p-8">
      {/* Container */}
      <div className="max-w-6xl mx-auto space-y-8 pb-12">
        {/* Header Console */}
        <header className="flex flex-col md:flex-row md:justify-between md:items-center gap-4 glass-card neon-border p-6 rounded-2xl shadow-xl">
          <div className="flex items-center gap-3">
            <div>
              <Get2ShareLockup className="text-base" />
              <h1 className="mt-1 font-expanded font-black text-xl text-white">Host Console</h1>
              <p className="text-xs text-g2-tertiary">Share Spots, guest cameras and photo review</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleLockHostPanel}
              className="bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-bold px-3.5 py-2.5 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition-all duration-300"
              title="Lock Host Panel"
            >
              <Lock className="w-4 h-4" /> Sign Out Host
            </button>
            <button
              onClick={onLaunchSlideshow}
              className="bg-g2-blue hover:bg-g2-blue-hover text-white font-bold px-4 py-2.5 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-g2-blue/10 transition-all duration-300"
            >
              <Radio className="w-4 h-4" /> Big-screen slideshow
            </button>
            <button
              onClick={onExit}
              className="bg-white/5 hover:bg-white/10 text-g2-secondary border border-white/10 font-semibold px-4 py-2.5 rounded-xl text-xs cursor-pointer transition-all duration-300"
            >
              Back to gallery
            </button>
          </div>
        </header>

        {/* Dashboard Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Column 1: Metadata, Governance Switches, Proximity Sharing & QR */}
          <div className="space-y-6 lg:col-span-1">
            {/* Event Metadata Settings Card */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Edit3 className="w-4 h-4 text-g2-blue-light" /> Event details
                </span>
                {savedMetadataSuccess && (
                  <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                    <CheckCircle2 className="w-3 h-3" /> Saved
                  </span>
                )}
              </h3>

              <div className="space-y-3 text-left">
                <div>
                  <label className="text-[10px] text-g2-tertiary font-bold uppercase tracking-wider block mb-1">
                    Event name
                  </label>
                  <input
                    type="text"
                    value={eventTitle}
                    onChange={(e) => setEventTitle(e.target.value)}
                    placeholder="e.g. Summer Gala 2026"
                    className="w-full bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-g2-blue transition-all"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-g2-tertiary font-bold uppercase tracking-wider block mb-1">
                    Announcement
                  </label>
                  <input
                    type="text"
                    value={eventSubtitle}
                    onChange={(e) => setEventSubtitle(e.target.value)}
                    placeholder="e.g. Tap any photo to react!"
                    className="w-full bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-g2-blue transition-all"
                  />
                </div>

                <button
                  onClick={handleSaveMetadata}
                  disabled={savingMetadata}
                  className="w-full bg-g2-blue hover:bg-g2-blue-hover text-white font-extrabold py-2.5 rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow-md shadow-g2-blue/20 transition-all"
                >
                  <Save className="w-4 h-4" />
                  {savingMetadata ? 'Saving…' : 'Save for everyone'}
                </button>
              </div>
            </div>

            {/* Moderation Switches */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center gap-1.5">
                <Sliders className="w-4 h-4 text-g2-blue-light" /> Moderation
              </h3>
              
              <div className="space-y-3">
                {/* Auto Approval Mode Switch */}
                <div className="flex items-center justify-between p-3.5 bg-black/40 border border-white/5 rounded-xl">
                  <div>
                    <p className="text-xs font-bold text-white">Auto-approve photos</p>
                    <p className="text-[10px] text-g2-muted mt-0.5">Photos go live without your review</p>
                  </div>
                  <button
                    onClick={handleToggleAutoApproval}
                    className={`w-12 h-6.5 rounded-full p-0.5 transition-colors cursor-pointer relative ${
                      autoApproval ? 'bg-g2-blue' : 'bg-white/10'
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
                    <p className="text-xs font-bold text-white">Allow camera requests</p>
                    <p className="text-[10px] text-g2-muted mt-0.5">Ask guests to share their camera for group shots</p>
                  </div>
                  <button
                    onClick={handleToggleGuestLens}
                    className={`w-12 h-6.5 rounded-full p-0.5 transition-colors cursor-pointer relative ${
                      guestLensEnabled ? 'bg-g2-blue' : 'bg-white/10'
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
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center justify-center gap-1.5">
                <QrCode className="w-4 h-4 text-g2-blue-light" /> Event QR code
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
                <p className="text-xs font-bold text-g2-text">Join link</p>
                <div className="bg-black/40 px-3 py-2 rounded-xl text-xs font-mono text-g2-blue-light break-all border border-white/5 flex items-center justify-between gap-2">
                  <span className="truncate">{joinLink}</span>
                  <a href={joinLink} target="_blank" rel="noreferrer" className="text-g2-muted hover:text-white shrink-0">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>

            {/* Proximity Onboarding Cards */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center gap-1.5">
                <Smartphone className="w-4 h-4 text-g2-blue-light" /> Ways to get guests in
              </h3>

              <div className="space-y-2.5">
                {/* NFC Coasters */}
                <div className="border border-white/5 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleTip('nfc')}
                    className="w-full bg-black/20 hover:bg-black/40 p-3 flex justify-between items-center text-xs font-bold text-g2-secondary cursor-pointer"
                  >
                    <span>NFC table coasters</span>
                    {openTipId === 'nfc' ? <ChevronUp className="w-4 h-4 text-g2-muted" /> : <ChevronDown className="w-4 h-4 text-g2-muted" />}
                  </button>
                  {openTipId === 'nfc' && (
                    <div className="p-3.5 bg-black/40 text-[11px] text-g2-tertiary leading-relaxed border-t border-white/5 space-y-1.5">
                      <p>Program inexpensive NFC tags ($0.30 each) using the free <strong>NFC Tools</strong> app on your smartphone.</p>
                      <p className="text-g2-muted">Write a URL record pointing to: <span className="text-g2-blue-light font-mono">{joinLink}</span></p>
                      <p>Stick them underneath bar mats or drink coasters. Guests tap their phones on the coaster and instantly join without typing code!</p>
                    </div>
                  )}
                </div>

                {/* Captive Wi-Fi Router Portal */}
                <div className="border border-white/5 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleTip('wifi')}
                    className="w-full bg-black/20 hover:bg-black/40 p-3 flex justify-between items-center text-xs font-bold text-g2-secondary cursor-pointer"
                  >
                    <span>Venue Wi-Fi splash page</span>
                    {openTipId === 'wifi' ? <ChevronUp className="w-4 h-4 text-g2-muted" /> : <ChevronDown className="w-4 h-4 text-g2-muted" />}
                  </button>
                  {openTipId === 'wifi' && (
                    <div className="p-3.5 bg-black/40 text-[11px] text-g2-tertiary leading-relaxed border-t border-white/5 space-y-1.5">
                      <p>You can force-open the event web app when guests connect to the venue router's guest Wi-Fi.</p>
                      <p>In your router settings, configure the <strong>Splash/Landing Page redirect</strong> to target: <span className="text-g2-blue-light font-mono">{joinLink}</span></p>
                      <p>Once connected, iOS & Android natively trigger a sliding viewport showing your event page instantly.</p>
                    </div>
                  )}
                </div>

                {/* Native Calendar Geofence */}
                <div className="border border-white/5 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleTip('calendar')}
                    className="w-full bg-black/20 hover:bg-black/40 p-3 flex justify-between items-center text-xs font-bold text-g2-secondary cursor-pointer"
                  >
                    <span>Calendar invite with location</span>
                    {openTipId === 'calendar' ? <ChevronUp className="w-4 h-4 text-g2-muted" /> : <ChevronDown className="w-4 h-4 text-g2-muted" />}
                  </button>
                  {openTipId === 'calendar' && (
                    <div className="p-3.5 bg-black/40 text-[11px] text-g2-tertiary leading-relaxed border-t border-white/5 space-y-1.5">
                      <p>Send calendar invitations (`.ics` files) with the venue address in the location field.</p>
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
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Laptop className="w-4 h-4 text-g2-blue-light" /> Share Spots ({tripods.length})
                </span>
                <span className="text-[10px] text-g2-muted font-medium">Any spare phone or tablet on a stand</span>
              </h3>

              <AddShareSpot />

              {tripods.length === 0 ? (
                <div className="p-6 bg-black/30 border border-white/5 rounded-xl text-center text-g2-muted text-xs">
                  No Share Spots yet. Tap “Add a Share Spot,” then enter the code on the device you want to use.
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
                            alt={`Live preview from ${tripod.nickname}`}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="text-center p-4">
                            <Radio className="w-6 h-6 text-g2-muted animate-ping mx-auto mb-1" />
                            <p className="text-[10px] text-g2-muted">Waiting for preview</p>
                          </div>
                        )}
                        <ShotOverlay shot={shots[tripod.sessionId]} />
                        <span className="absolute top-2 left-2 text-[10px] font-bold bg-black/60 backdrop-blur-md text-g2-blue-light px-2 py-0.5 rounded-full border border-g2-blue/20">
                          {tripod.nickname}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveShareSpot(tripod)}
                          aria-label={`Remove ${tripod.nickname}`}
                          title="Remove this Share Spot"
                          className="absolute bottom-2 left-2 p-1.5 bg-black/60 hover:bg-red-500/30 border border-white/10 hover:border-red-400/40 text-g2-secondary hover:text-red-300 rounded-full cursor-pointer transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <div className="absolute top-2 right-2 flex items-center gap-1.5 text-[10px] bg-black/60 px-2 py-0.5 rounded-full">
                          <Battery className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-g2-secondary">{tripod.deviceInfo?.batteryLevel || 100}%</span>
                        </div>
                      </div>

                      <div className="p-3.5 bg-black/40 flex justify-between items-center">
                        <span className="text-[10px] text-g2-muted font-mono" aria-live="polite">
                          {shotStatusText(shots[tripod.sessionId])}
                        </span>
                        <ShutterButton
                          shot={shots[tripod.sessionId]}
                          onFire={() => fireShutter(tripod.sessionId)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Tap-to-Acquire Guest Handshakes ( Sara's Active Lens ) */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center gap-1.5">
                  <Smartphone className="w-4 h-4 text-g2-blue-light" /> Guest cameras
                </h3>
                <div className="flex items-center gap-2">
                  {!guestLensEnabled && (
                    <span className="text-[10px] bg-red-950/80 border border-red-800/40 text-red-400 font-bold px-2.5 py-0.5 rounded-full">
                      Turned off
                    </span>
                  )}
                  <button
                    onClick={handlePruneStaleSessions}
                    className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-g2-secondary font-bold px-2.5 py-1 rounded-lg flex items-center gap-1 cursor-pointer transition-colors"
                    title="Remove sessions inactive for >15 minutes"
                  >
                    <UserX className="w-3 h-3 text-red-400" /> Remove inactive
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
                      {lensState.activeRequester && <ShotOverlay shot={shots[lensState.activeRequester]} />}
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-g2-blue-light flex items-center gap-1">
                        <span className="w-2 h-2 bg-red-600 rounded-full animate-ping"></span> Camera shared
                      </h4>
                      <p className="text-[10px] text-gray-400">You're seeing their camera. Take the photo when the group is ready.</p>
                    </div>
                  </div>

                  {/* Shutter Trigger Button */}
                  {lensState.activeRequester && (
                    <div className="flex flex-col items-center gap-1">
                      <ShutterButton
                        size="md"
                        shot={shots[lensState.activeRequester]}
                        onFire={() => fireShutter(lensState.activeRequester!)}
                      />
                      <span className="text-[10px] text-g2-muted font-mono" aria-live="polite">
                        {shotStatusText(shots[lensState.activeRequester], '')}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {activeGuests.length === 0 ? (
                <div className="p-6 bg-black/30 border border-white/5 rounded-xl text-center text-g2-muted text-xs">
                  No guests connected yet.
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
                          <div className="w-10 h-10 bg-black/50 border border-white/5 rounded-lg flex items-center justify-center font-bold text-g2-secondary text-sm">
                            {guest.nickname.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="text-xs font-bold text-white flex items-center gap-2">
                              {guest.nickname}
                              <button
                                onClick={() => handleKickGuestSession(guest.sessionId, guest.nickname)}
                                className="p-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-md text-[10px] font-bold transition-colors cursor-pointer"
                                title="Remove guest" aria-label={`Remove ${guest.nickname}`}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </p>
                            <p className="text-[10px] text-g2-muted font-mono mt-0.5">
                              Active: {new Date(guest.lastActive).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </p>
                          </div>
                        </div>

                        {/* Stream Preview if active */}
                        {isStreaming && guest.stream_frame && (
                          <div className="w-32 aspect-video bg-black/40 rounded-lg border border-white/5 overflow-hidden relative">
                            <img src={guest.stream_frame} alt="Preview" className="w-full h-full object-cover" />
                            <span className="absolute bottom-1 right-1 bg-red-600 w-1.5 h-1.5 rounded-full animate-ping" />
                            <ShotOverlay shot={shots[guest.sessionId]} />
                          </div>
                        )}

                        <div className="flex items-center gap-2 shrink-0">
                          {isRequesting && (
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-g2-tertiary animate-pulse">Waiting for them to accept…</span>
                              <button
                                onClick={() => handleCancelLens(guest.sessionId)}
                                className="bg-white/5 hover:bg-white/10 text-g2-tertiary font-bold px-3 py-1.5 rounded-lg text-[10px] cursor-pointer transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          )}

                          {isStreaming && (
                            <div className="flex items-center gap-2">
                              <ShutterButton
                                variant="white"
                                shot={shots[guest.sessionId]}
                                onFire={() => fireShutter(guest.sessionId)}
                              />
                              <button
                                onClick={() => handleCancelLens(guest.sessionId)}
                                className="bg-white/5 hover:bg-white/10 text-g2-tertiary px-2.5 py-1.5 rounded-lg text-[10px] cursor-pointer"
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
                                className="bg-g2-blue/15 border border-g2-blue/40 text-g2-blue-light font-bold px-3 py-1.5 rounded-lg text-[10px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                Ask again
                              </button>
                            </div>
                          )}

                          {(!guest.lens_status || guest.lens_status === 'off') && (
                            <button
                              onClick={() => handleRequestLens(guest.sessionId)}
                              disabled={!guestLensEnabled}
                              className="bg-white/5 border border-white/10 hover:bg-g2-blue hover:text-white text-g2-blue-light font-bold px-3.5 py-2 rounded-xl text-xs transition-all duration-300 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Ask to use camera
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
                <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center gap-1.5">
                  <Shield className="w-4 h-4 text-g2-blue-light" /> Review queue ({pendingPhotos.length + flaggedPhotos.length})
                </h3>
                
                <div className="flex items-center gap-2">
                  {flaggedPhotos.length > 0 && (
                    <button
                      onClick={handleClearAllFlagged}
                      className="text-[10px] bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2.5 py-1 rounded-lg font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Trash2 className="w-3 h-3" /> Delete all reported ({flaggedPhotos.length})
                    </button>
                  )}
                  {pendingPhotos.length > 0 && (
                    <button
                      onClick={handleDeleteAllPending}
                      className="text-[10px] bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 px-2.5 py-1 rounded-lg font-bold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Trash2 className="w-3 h-3" /> Delete all waiting ({pendingPhotos.length})
                    </button>
                  )}
                </div>
              </div>

              {pendingPhotos.length === 0 && flaggedPhotos.length === 0 ? (
                <div className="p-6 bg-black/30 border border-white/5 rounded-xl text-center text-g2-muted text-xs">
                  Nothing to review right now.
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
                            <AlertCircle className="w-4 h-4 shrink-0" /> Reported by a guest
                          </div>
                          <p className="text-xs font-bold text-g2-text mt-1">From {photo.nickname}</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDeletePhoto(photo.id)}
                          className="bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-400 font-bold p-2.5 rounded-xl text-xs cursor-pointer transition-colors"
                          title="Delete photo" aria-label="Delete photo"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleRejectPhoto(photo.id)}
                          className="bg-white/5 hover:bg-red-500/10 hover:text-red-400 border border-white/10 text-g2-tertiary p-2.5 rounded-xl text-xs cursor-pointer transition-colors"
                          title="Decline" aria-label="Decline"
                        >
                          <X className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleApprovePhoto(photo.id)}
                          className="bg-emerald-500/25 hover:bg-emerald-500/35 border border-emerald-500/30 text-emerald-400 font-bold p-2.5 rounded-xl text-xs cursor-pointer"
                          title="Clear report and approve" aria-label="Clear report and approve"
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
                          <p className="text-xs font-bold text-white">From {photo.nickname}</p>
                          <p className="text-[10px] text-g2-muted font-mono mt-0.5">
                            Posted {new Date(photo.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleDeletePhoto(photo.id)}
                          className="bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-400 font-bold p-2.5 rounded-xl text-xs cursor-pointer transition-colors"
                          title="Delete photo" aria-label="Delete photo"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleRejectPhoto(photo.id)}
                          className="bg-white/5 hover:bg-red-500/10 hover:text-red-400 border border-white/10 text-g2-tertiary p-2.5 rounded-xl text-xs cursor-pointer transition-colors"
                          title="Decline" aria-label="Decline"
                        >
                          <X className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleApprovePhoto(photo.id)}
                          className="bg-g2-blue hover:bg-g2-blue-hover text-white font-extrabold p-2.5 rounded-xl text-xs cursor-pointer transition-all duration-300 shadow-md shadow-g2-blue/20"
                          title="Approve" aria-label="Approve"
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

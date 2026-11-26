import React, { useEffect, useState } from 'react';
import { ALBUM_SAVING_OPTIONS, AlbumSaving, albumSavingOf } from '../savePhotos';
import {
  Shield, Check, X, Camera, Info, QrCode, Sliders, Smartphone, Laptop,
  Battery, AlertCircle, Trash2, HelpCircle, ExternalLink, Images, RefreshCw, ChevronDown, ChevronUp, Radio,
  Lock, Edit3, Save, CheckCircle2, UserX, Image as ImageIcon, Clock, EyeOff, Undo2
} from 'lucide-react';
import {
  collection, query, onSnapshot, doc, setDoc, updateDoc, deleteDoc, serverTimestamp, getDocs
} from 'firebase/firestore';
import { db, deletePhotoFile, handleFirestoreError, OperationType } from '../firebase';
import { ALBUM_LENGTH, COHOST_LIMITS, DEVICE_LIMITS, RUN_LENGTH, guestLimitOf, runEndOf, setEventStart, blockGuest, deleteEvent, eventPhase, expiryOf, tierOf, formatDay, formatWhen, joinUrl, paths, removeGuest, resetJoinCode, saveEventDetails, setEventEnd, toLocalInput, unblockGuest } from '../events';
import { useEvent } from '../EventContext';
import { Photo, GuestSession } from '../types';
import QRCode from 'qrcode';
import Get2ShareLockup from './Get2ShareLockup';
import HostTabs from './HostTabs';
import { useRemoteShutter } from './useRemoteShutter';
import { ShutterButton, ShotOverlay, shotStatusText } from './ShutterButton';
import AddShareSpot from './AddShareSpot';
import ShareSpotTile from './ShareSpotTile';
import ScreensPanel from './ScreensPanel';
import PlanLimitNote from './PlanLimitNote';
import { takeSuggestedPlan, useEventFeatures, useGuestCount, useUpgradeOffers } from '../plan';
import { PlanBanner, PlanCard } from './PlanCard';
import CoHostsPanel from './CoHostsPanel';
import { HostShareButtons } from './EventShare';
import { shareFrameOn, useEventPaid } from '../shareFrame';
import WalkthroughPanel from './WalkthroughPanel';
import HostCameraButton from './HostCameraButton';
import GroupShotButton from './GroupShotButton';
import { useConsolePresence } from './useConsolePresence';
import { useSpotLiveness } from './useSpotLiveness';

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
  isAdmin?: boolean;
  signedInEmail: string | null;
  authError: string;
  onHostSignIn: () => void;
  onHostSignOut: () => void;
  /** Switch to the event's gallery (the Gallery tab). */
  onOpenGallery?: () => void;
}

export default function HostDashboard({
  onLaunchSlideshow,
  onExit,
  sessionId,
  lensState,
  setLensState,
  isHost,
  isAdmin = false,
  signedInEmail,
  authError,
  onHostSignIn,
  onHostSignOut,
  onOpenGallery,
}: HostDashboardProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [sessions, setSessions] = useState<GuestSession[]>([]);
  const { event } = useEvent();
  const eventId = event.id;
  const [autoApproval, setAutoApproval] = useState(event.autoApproval);
  const [guestLensEnabled, setGuestLensEnabled] = useState(event.guestLensEnabled);
  const [lensSharing, setLensSharing] = useState(!!event.lensSharing);
  const [eventTitle, setEventTitle] = useState(event.name);
  const [eventSubtitle, setEventSubtitle] = useState(event.subtitle || '');
  const [resettingLink, setResettingLink] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState('');
  const [galleryLimit, setGalleryLimit] = useState(24);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [hiddenLimit, setHiddenLimit] = useState(24);
  const [restoringAll, setRestoringAll] = useState(false);
  const [endInput, setEndInput] = useState(() => (event.endsAt ? toLocalInput(new Date(event.endsAt.toMillis())) : ''));
  const [startInput, setStartInput] = useState(() => (event.startsAt ? toLocalInput(new Date(event.startsAt.toMillis())) : ''));
  const [timingBusy, setTimingBusy] = useState(false);
  const [timingMsg, setTimingMsg] = useState('');
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setEndInput(event.endsAt ? toLocalInput(new Date(event.endsAt.toMillis())) : '');
    setStartInput(event.startsAt ? toLocalInput(new Date(event.startsAt.toMillis())) : '');
  }, [event.endsAt?.toMillis?.()]);
  const phase = eventPhase(event, nowTick);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [savedMetadataSuccess, setSavedMetadataSuccess] = useState(false);

  const [openTipId, setOpenTipId] = useState<string | null>(null);
  // Removing or blocking a guest: who the dialog is about, and the blocked list.
  const [removeTarget, setRemoveTarget] = useState<{ sessionId: string; nickname: string } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const [guestNote, setGuestNote] = useState('');
  const [blockedGuests, setBlockedGuests] = useState<{ uid: string; nickname: string }[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  const joinLink = joinUrl(event.joinCode);

  // Keep toggles in step with the event (another host may change them).
  useEffect(() => {
    setAutoApproval(event.autoApproval);
    setGuestLensEnabled(event.guestLensEnabled);
    setLensSharing(!!event.lensSharing);
  }, [event.autoApproval, event.guestLensEnabled, event.lensSharing]);

  // Remote "Take photo": tracks each shot from tap → device heard it → photo landed.
  const { shots, fire: fireShutter } = useRemoteShutter(eventId, sessions, photos);

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
    const q = query(paths.photos(eventId));
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
  }, [isHost, eventId]);

  // 2. Listen for registered Sessions (for Tripod devices and ad-hoc guest lenses) — host only
  useEffect(() => {
    if (!isHost) return;
    const q = query(paths.sessions(eventId));
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
  }, [isHost, eventId]);

  // Devices this event's hosts have blocked — host only
  useEffect(() => {
    if (!isHost) return;
    return onSnapshot(
      paths.blocked(eventId),
      (snap) => setBlockedGuests(snap.docs.map((d) => ({ uid: d.id, nickname: (d.data() as any).nickname || 'Guest' }))),
      (err) => console.error('Error listening to blocked guests:', err)
    );
  }, [isHost, eventId]);

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
      const docRef = paths.session(eventId, targetSessionId);
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
      await saveEventDetails(eventId, event.joinCode, eventTitle || event.name, eventSubtitle);
      setSavingMetadata(false);
      setSavedMetadataSuccess(true);
      setTimeout(() => setSavedMetadataSuccess(false), 3000);
    } catch (e) {
      console.error('Failed to save metadata:', e);
      setSavingMetadata(false);
      handleFirestoreError(e, OperationType.UPDATE, `events/${eventId}`);
    }
  };

  // Toggle Allow Guest Lens Requests
  const handleToggleGuestLens = async () => {
    try {
      const nextVal = !guestLensEnabled;
      setGuestLensEnabled(nextVal);
      await updateDoc(paths.event(eventId), { guestLensEnabled: nextVal });
    } catch (e) {
      console.error('Failed to update guest lens setting:', e);
      handleFirestoreError(e, OperationType.UPDATE, `events/${eventId}`);
    }
  };

  // When guests can save other people's photos to their devices (savePhotos.ts).
  const albumSaving = albumSavingOf(event);
  const [savingMsg, setSavingMsg] = useState('');
  const handleAlbumSaving = async (next: AlbumSaving) => {
    if (next === albumSaving) return;
    setSavingMsg('');
    try {
      await updateDoc(paths.event(eventId), { albumSaving: next });
    } catch (e) {
      console.error('Failed to update album saving:', e);
      setSavingMsg("Couldn't change that. Try again.");
    }
  };

  // Let guests borrow each other's cameras (GuestLens). Off unless turned on here.
  // The strip on shared photos: always on for a free event, a paid one can turn it off.
  const eventPaid = useEventPaid(eventId, isHost);
  // The plan (features/{eventId}): guests, Share Spots and TVs, the album, and what it can upgrade to.
  const features = useEventFeatures(eventId, isHost);
  const tier = tierOf(features);
  const deviceLimit = DEVICE_LIMITS[tier];
  const guestCount = useGuestCount(eventId, isHost);
  const guestLimit = guestLimitOf(features);
  const upgrades = useUpgradeOffers(eventId, isHost, tier);
  // "About how many people?" at creation: point the plan card at the upgrade that fits.
  const [suggestedPlan] = useState(() => takeSuggestedPlan(eventId));
  const scrolledToPlan = React.useRef(false);
  useEffect(() => {
    // Once, when the prices arrive: bring the plan card into view.
    if (!suggestedPlan || scrolledToPlan.current || upgrades.offers.length === 0) return;
    scrolledToPlan.current = true;
    document.getElementById('plan-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [suggestedPlan, upgrades.offers.length]);
  const shareFrame = shareFrameOn(event);
  const [shareFrameNote, setShareFrameNote] = useState('');
  const handleToggleShareFrame = async () => {
    setShareFrameNote('');
    if (!eventPaid && shareFrame) return; // free events keep it; the rules say the same
    try {
      await updateDoc(paths.event(eventId), { shareFrame: !shareFrame });
    } catch (e) {
      console.error('Failed to change the shared-photo strip:', e);
      setShareFrameNote("Couldn't change that. Check your connection and try again.");
    }
  };

  const handleToggleLensSharing = async () => {
    const nextVal = !lensSharing;
    setLensSharing(nextVal);
    try {
      await updateDoc(paths.event(eventId), { lensSharing: nextVal });
    } catch (e) {
      setLensSharing(!nextVal);
      console.error('Failed to update camera borrowing:', e);
      handleFirestoreError(e, OperationType.UPDATE, `events/${eventId}`);
    }
  };

  // Bulk Delete Pending Photos
  const handleDeleteAllPending = async () => {
    const pendingList = photos.filter((p) => p.status === 'pending');
    if (pendingList.length === 0) return;

    if (!window.confirm(`Delete all ${pendingList.length} photos waiting for review?`)) return;

    try {
      await Promise.all(pendingList.map((p) => deleteDoc(paths.photo(eventId, p.id)).then(() => deletePhotoFile(p.url))));
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
      await Promise.all(flaggedList.map((p) => deleteDoc(paths.photo(eventId, p.id)).then(() => deletePhotoFile(p.url))));
    } catch (e) {
      console.error('Failed bulk clear flagged photos:', e);
      handleFirestoreError(e, OperationType.DELETE, 'photos');
    }
  };

  // Clear idle guests from the list (15+ minutes without the app open). They are not
  // removed from the event: they show up again as soon as they open it.
  const handlePruneStaleSessions = async () => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    const staleSessions = sessions.filter((s) => s.role === 'guest' && (!s.lastActive || s.lastActive < cutoff));

    if (staleSessions.length === 0) {
      setGuestNote('Nobody is idle: everyone has had the app open in the last 15 minutes.');
      return;
    }

    if (!window.confirm(`Clear ${staleSessions.length} idle ${staleSessions.length === 1 ? 'guest' : 'guests'} from this list? They stay in the event and reappear when they open it again.`)) return;

    try {
      await Promise.all(staleSessions.map((s) => deleteDoc(paths.session(eventId, s.sessionId))));
      setGuestNote(`Cleared ${staleSessions.length} idle ${staleSessions.length === 1 ? 'guest' : 'guests'} from the list.`);
    } catch (e) {
      console.error('Failed clearing idle sessions:', e);
      handleFirestoreError(e, OperationType.DELETE, 'sessions');
    }
  };

  // Remove a guest (they can rejoin) or block their device (they can't).
  const handleRemoveGuest = async (mode: 'remove' | 'block' | 'blockHide') => {
    if (!removeTarget || removeBusy) return;
    const { sessionId: guestUid, nickname: guestNickname } = removeTarget;
    setRemoveBusy(true);
    setRemoveError('');
    try {
      if (mode === 'remove') {
        await removeGuest(eventId, guestUid);
        setGuestNote(`${guestNickname} was removed. They can join again with the code.`);
      } else {
        const hidden = await blockGuest(eventId, guestUid, guestNickname, sessionId, {
          hidePhotos: mode === 'blockHide',
          expireAt: expiryOf(event).expireAt ?? null,
        });
        setGuestNote(
          mode === 'blockHide'
            ? `${guestNickname} is blocked, and ${hidden} of their ${hidden === 1 ? 'photo is' : 'photos are'} hidden from the gallery. Restore them any time under Hidden photos.`
            : `${guestNickname} is blocked. Their photos stay in the gallery.`
        );
      }
      setRemoveTarget(null);
    } catch (e) {
      console.error('Failed removing guest:', e);
      setRemoveError("That didn't work. Check your connection and try again.");
    } finally {
      setRemoveBusy(false);
    }
  };

  const handleUnblockGuest = async (uid: string, guestNickname: string) => {
    try {
      await unblockGuest(eventId, uid);
      setGuestNote(`${guestNickname} is unblocked and can join again with the code.`);
    } catch (e) {
      console.error('Failed unblocking guest:', e);
      setGuestNote("Couldn't unblock them. Check your connection and try again.");
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
      await updateDoc(paths.event(eventId), { autoApproval: nextVal });
    } catch (e) {
      console.error('Failed to update approval setting:', e);
      handleFirestoreError(e, OperationType.UPDATE, `events/${eventId}`);
    }
  };

  const handleApprovePhoto = async (id: string) => {
    try {
      const docRef = paths.photo(eventId, id);
      await updateDoc(docRef, { status: 'approved' });
    } catch (e) {
      console.error('Approve failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, `photos/${id}`);
    }
  };

  const handleRejectPhoto = async (id: string) => {
    try {
      const docRef = paths.photo(eventId, id);
      await updateDoc(docRef, { status: 'rejected' });
    } catch (e) {
      console.error('Reject failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, `photos/${id}`);
    }
  };

  // Bring a hidden photo back into the gallery.
  const handleRestorePhoto = async (id: string) => {
    try {
      await updateDoc(paths.photo(eventId, id), { status: 'approved' });
    } catch (e) {
      console.error('Restore failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, `photos/${id}`);
    }
  };

  const handleRestoreAllHidden = async () => {
    const hidden = photos.filter((p) => p.status === 'rejected');
    if (hidden.length === 0 || restoringAll) return;
    if (!window.confirm(`Put all ${hidden.length} hidden ${hidden.length === 1 ? 'photo' : 'photos'} back in the gallery?`)) return;
    setRestoringAll(true);
    try {
      await Promise.all(hidden.map((p) => updateDoc(paths.photo(eventId, p.id), { status: 'approved' })));
    } catch (e) {
      console.error('Restore all failed:', e);
      handleFirestoreError(e, OperationType.UPDATE, 'photos');
    } finally {
      setRestoringAll(false);
    }
  };

  const handleDeletePhoto = async (id: string) => {
    if (!window.confirm('Delete this photo for everyone?')) return;
    try {
      const url = photos.find((p) => p.id === id)?.url;
      await deleteDoc(paths.photo(eventId, id));
      if (url) deletePhotoFile(url);
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
      await deleteDoc(paths.session(eventId, spot.sessionId));
      await deleteDoc(paths.member(eventId, spot.sessionId)).catch(() => {});
    } catch (e) {
      console.error('Remove Share Spot failed:', e);
      handleFirestoreError(e, OperationType.DELETE, `sessions/${spot.sessionId}`);
    }
  };

  // Ad-Hoc Guest Lens invitation trigger
  const handleRequestLens = async (guestSessionId: string) => {
    try {
      const docRef = paths.session(eventId, guestSessionId);
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
      const docRef = paths.session(eventId, guestSessionId);
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

  const changeEnd = async (end: Date, msg: string) => {
    try {
      setTimingBusy(true);
      setTimingMsg('');
      await setEventEnd(eventId, event.joinCode, end, tier);
      setTimingMsg(msg);
      setTimeout(() => setTimingMsg(''), 3000);
    } catch (e) {
      console.error('Changing the end time failed:', e);
      setTimingMsg("Couldn't change the end time. Try again.");
    } finally {
      setTimingBusy(false);
    }
  };

  const handleSaveEnd = () => {
    const d = new Date(endInput);
    if (!endInput || isNaN(d.getTime())) {
      setTimingMsg('Pick a date and time first.');
      return;
    }
    changeEnd(d, 'End time saved.');
  };

  const handleEndNow = () => {
    if (!window.confirm('End the event now? Guests get an hour for last photos, then the gallery becomes an album they can view and save.')) return;
    changeEnd(new Date(), 'Event ended.');
  };

  // Events with a start time run for the plan's time from the start (RUN_HOURS); reopening stays inside it.
  const hasStart = !!event.startsAt;
  const runEnd = runEndOf(event, tier);
  const reopenUntil = hasStart && runEnd !== null ? Math.min(nowTick + 3 * 3600000, runEnd) : nowTick + 3 * 3600000;
  const canReopen = reopenUntil - nowTick >= 15 * 60000;
  const handleReopen = () => changeEnd(new Date(reopenUntil),
    reopenUntil - nowTick >= 3 * 3600000 - 60000 ? 'Reopened for 3 more hours.' : `Reopened until ${new Date(reopenUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);

  const changeStart = async (start: Date, msg: string) => {
    try {
      setTimingBusy(true);
      setTimingMsg('');
      await setEventStart(eventId, event.joinCode, start, tier);
      setTimingMsg(msg);
      setTimeout(() => setTimingMsg(''), 3000);
    } catch (e) {
      console.error('Changing the start time failed:', e);
      setTimingMsg("Couldn't change the start time. Try again.");
    } finally {
      setTimingBusy(false);
    }
  };
  const handleSaveStart = () => {
    const d = new Date(startInput);
    if (!startInput || isNaN(d.getTime())) { setTimingMsg('Pick a date and time first.'); return; }
    if (d.getTime() < Date.now() - 10 * 60000) { setTimingMsg('Pick now or a time ahead, or tap Start now.'); return; }
    changeStart(d.getTime() <= Date.now() ? new Date() : d, 'Start time saved.');
  };
  const handleStartNow = () => changeStart(new Date(), 'Started. Photos are open.');

  // New join link: the old QR code and link stop working; people already in stay in.
  const handleResetJoinLink = async () => {
    if (!window.confirm('Make a new join link? The current QR code and link will stop working. Guests who already joined stay in.')) return;
    try {
      setResettingLink(true);
      await resetJoinCode(eventId, event.joinCode, event.name, event.expireAt);
    } catch (e) {
      console.error('Reset join link failed:', e);
      alert("Couldn't make a new link. Check your connection and try again.");
    } finally {
      setResettingLink(false);
    }
  };

  // Delete the whole event: photos and their files, guests, devices, the join link.
  const canDelete = isAdmin || event.ownerUid === sessionId;
  const handleDeleteEvent = async () => {
    if (deleteText.trim() !== event.name.trim()) return;
    try {
      setDeleting(true);
      setDeleteMsg('Deleting…');
      await deleteEvent(event, (msg) => setDeleteMsg(msg));
      onExit();
    } catch (e) {
      console.error('Delete event failed:', e);
      setDeleteMsg("Couldn't finish deleting. Try again; anything already removed stays removed.");
      setDeleting(false);
    }
  };

  const toggleTip = (id: string) => {
    setOpenTipId(openTipId === id ? null : id);
  };

  const pendingPhotos = photos.filter((p) => p.status === 'pending');
  const flaggedPhotos = photos.filter((p) => p.flagged === true && p.status !== 'rejected');
  const approvedPhotos = photos.filter((p) => p.status === 'approved');
  const hiddenPhotos = photos.filter((p) => p.status === 'rejected');
  const tripods = sessions.filter((s) => s.role === 'tripod');

  // Share Spots only send previews while this console is open; one can be focused for speed.
  const { focusSpot, setFocusSpot } = useConsolePresence(eventId, isHost);
  const spotLiveness = useSpotLiveness(tripods);
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
              Sign in with the Google account that hosts “{event.name}” to open its Host Console.
            </p>
            {signedInEmail && (
              <p className="text-[11px] text-amber-300">
                Signed in as {signedInEmail}, which isn't a host of this event. Ask the event owner to add you as a co-host.
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
      <HostCameraButton hostUid={sessionId} variant="floating" />
      {/* Container */}
      <div className="max-w-6xl mx-auto space-y-8 pb-24 md:pb-12">
        {isHost && onOpenGallery && (
          <div className="flex justify-center">
            <HostTabs active="console" onGallery={onOpenGallery} onConsole={() => {}} />
          </div>
        )}
        {/* Header Console */}
        <header className="flex flex-col md:flex-row md:justify-between md:items-center gap-4 glass-card neon-border p-6 rounded-2xl shadow-xl">
          <div className="flex items-center gap-3">
            <div>
              <Get2ShareLockup className="text-base" />
              <h1 className="mt-1 font-expanded font-black text-xl text-white">{event.name}</h1>
              <p className="text-xs text-g2-tertiary">Host Console · Share Spots, guest cameras and photo review</p>
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
            <HostCameraButton hostUid={sessionId} />
            <GroupShotButton hostUid={sessionId} />
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
              My events
            </button>
          </div>
        </header>

        <PlanBanner tier={tier} guests={guestCount} guestLimit={guestLimit} phase={phase}
          closesMs={event.expireAt?.toMillis?.() ?? null}
          endsMs={event.endsAt?.toMillis?.() ?? null} runEndMs={hasStart ? runEnd : null} up={upgrades} eventName={event.name} eventId={eventId} now={nowTick} />

        {/* Dashboard Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Column 1: Metadata, Governance Switches, Proximity Sharing & QR */}
          <div className="space-y-6 lg:col-span-1">
            <PlanCard tier={tier} guests={guestCount} guestLimit={guestLimit} up={upgrades}
              cohosts={Math.max(0, (event.hostUids || []).length - 1)}
              eventName={event.name} eventId={eventId} suggested={suggestedPlan} />
            {/* Event timing: live → wrap-up → album */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-g2-blue-light" /> Event timing
                </span>
                <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${
                  phase === 'upcoming' ? 'text-g2-blue-light border-g2-blue/40 bg-g2-blue/10'
                  : phase === 'live' ? 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10'
                  : phase === 'wrapup' ? 'text-amber-300 border-amber-400/30 bg-amber-400/10'
                  : 'text-g2-secondary border-white/10 bg-white/5'
                }`}>
                  {phase === 'upcoming' ? 'Upcoming' : phase === 'live' ? 'Live' : phase === 'wrapup' ? 'Wrapping up' : phase === 'album' ? 'Album' : 'Expired'}
                </span>
              </h3>
              <p className="text-xs text-g2-tertiary leading-relaxed">
                {phase === 'upcoming' && event.startsAt
                  ? `Starts ${formatWhen(event.startsAt.toMillis())}. Guests can join now; photos open then and stay open ${RUN_LENGTH[tier]}.`
                  : !event.endsAt
                  ? 'No end time yet. Set one so the gallery closes and cleans up on its own.'
                  : phase === 'live' && hasStart
                    ? `Photos open until ${formatWhen(event.endsAt.toMillis())}. Last photos an hour after that.`
                  : phase === 'live'
                    ? `Ends ${formatWhen(event.endsAt.toMillis())}. Last photos an hour after that.`
                    : phase === 'wrapup'
                      ? `Ended ${formatWhen(event.endsAt.toMillis())}. Last photos until ${new Date(event.endsAt.toMillis() + 3600000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
                      : `New photos are closed. Guests can view and save the album until ${event.expireAt ? formatDay(event.expireAt.toMillis()) : 'it expires'}, then it's deleted.`}
              </p>
              {phase === 'upcoming' ? (
                <>
                  <div className="space-y-1.5">
                    <label htmlFor="ev-start-edit" className="text-[11px] font-bold uppercase tracking-wider text-g2-muted">Starts</label>
                    <div className="flex gap-2">
                      <input
                        id="ev-start-edit"
                        type="datetime-local"
                        value={startInput}
                        onChange={(e) => setStartInput(e.target.value)}
                        className="flex-1 min-w-0 bg-black/40 border border-white/10 focus:border-g2-blue rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none [color-scheme:dark]"
                      />
                      <button type="button" onClick={handleSaveStart} disabled={timingBusy}
                        className="px-3.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-bold cursor-pointer disabled:opacity-60">
                        Save
                      </button>
                    </div>
                  </div>
                  <button type="button" onClick={handleStartNow} disabled={timingBusy}
                    className="w-full h-10 rounded-xl bg-g2-blue hover:bg-g2-blue-hover text-white text-xs font-bold cursor-pointer disabled:opacity-60 transition-colors">
                    Start now
                  </button>
                </>
              ) : (<>
              {!hasStart && (
              <div className="space-y-1.5">
                <label htmlFor="ev-end-edit" className="text-[11px] font-bold uppercase tracking-wider text-g2-muted">Ends</label>
                <div className="flex gap-2">
                  <input
                    id="ev-end-edit"
                    type="datetime-local"
                    value={endInput}
                    onChange={(e) => setEndInput(e.target.value)}
                    className="flex-1 min-w-0 bg-black/40 border border-white/10 focus:border-g2-blue rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none [color-scheme:dark]"
                  />
                  <button
                    type="button"
                    onClick={handleSaveEnd}
                    disabled={timingBusy}
                    className="px-3.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-bold cursor-pointer disabled:opacity-60"
                  >
                    Save
                  </button>
                </div>
              </div>
              )}
              {phase === 'live' ? (
                <button
                  type="button"
                  onClick={handleEndNow}
                  disabled={timingBusy}
                  className="w-full h-10 rounded-xl border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-bold cursor-pointer disabled:opacity-60 transition-colors"
                >
                  End the event now
                </button>
              ) : canReopen ? (
                <button
                  type="button"
                  onClick={handleReopen}
                  disabled={timingBusy}
                  className="w-full h-10 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white text-xs font-bold cursor-pointer disabled:opacity-60 transition-colors"
                >
                  {reopenUntil - nowTick >= 3 * 3600000 - 60000
                    ? 'Reopen for 3 more hours'
                    : `Reopen until ${new Date(reopenUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
                </button>
              ) : (
                <p className="text-[12px] leading-relaxed text-g2-secondary">
                  {tier === 'free' ? 'Free events run for a day from the start. Upgrade to Party to keep going for 3 days, or Big Event for 14.'
                    : tier === 'party' ? 'Party events run for 3 days from the start. A Big Event keeps going for 14.'
                    : 'This event has run its 14 days.'}
                </p>
              )}
              </>)}
              <p className="text-[10px] text-g2-muted leading-relaxed">
                The album stays up for {ALBUM_LENGTH[tier]} after the end, then photos and guest info are deleted automatically.
                {tier === 'free' && ' Upgrading keeps it for 6 months (Party) or a year (Big Event).'}
                {tier === 'party' && ' A Big Event keeps it for a year.'}
              </p>
              {timingMsg && <p className="text-[11px] text-g2-secondary" aria-live="polite">{timingMsg}</p>}
            </div>

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
                    Welcome line
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
                  {savingMetadata ? 'Saving…' : 'Save event details'}
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

                {/* Guests borrowing each other's cameras */}
                <div className="flex items-center justify-between p-3.5 bg-black/40 border border-white/5 rounded-xl">
                  <div>
                    <p className="text-xs font-bold text-white">Flick: let guests borrow cameras</p>
                    <p className="text-[10px] text-g2-muted mt-0.5">A guest can ask another to lend their camera, so they can be in the shot</p>
                  </div>
                  <button
                    onClick={handleToggleLensSharing}
                    role="switch"
                    aria-checked={lensSharing}
                    aria-label="Flick: let guests borrow cameras"
                    className={`w-12 h-6.5 rounded-full p-0.5 transition-colors cursor-pointer relative shrink-0 ${
                      lensSharing ? 'bg-g2-blue' : 'bg-white/10'
                    }`}
                  >
                    <div
                      className={`w-5.5 h-5.5 bg-white rounded-full shadow-md transform transition-transform ${
                        lensSharing ? 'translate-x-5.5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* The strip on shared photos */}
                <div className="flex items-center justify-between gap-3 p-3.5 bg-black/40 border border-white/5 rounded-xl">
                  <div>
                    <p className="text-xs font-bold text-white">Add the event name to shared photos</p>
                    <p className="text-[10px] text-g2-muted mt-0.5">
                      {eventPaid
                        ? "A slim strip under photos guests share, with your event's name and share.get2.one. Saved copies stay clean."
                        : "A slim strip under photos guests share, with your event's name and share.get2.one. Big Events, and events with a Flow Pass, can turn it off."}
                    </p>
                    {shareFrameNote && <p className="text-[10px] text-amber-300 mt-1" aria-live="polite">{shareFrameNote}</p>}
                  </div>
                  <button
                    onClick={handleToggleShareFrame}
                    disabled={!eventPaid && shareFrame}
                    role="switch"
                    aria-checked={shareFrame}
                    aria-label="Add the event name to shared photos"
                    className={`w-12 h-6.5 rounded-full p-0.5 transition-colors relative shrink-0 ${
                      shareFrame ? 'bg-g2-blue' : 'bg-white/10'
                    } ${!eventPaid && shareFrame ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <div
                      className={`w-5.5 h-5.5 bg-white rounded-full shadow-md transform transition-transform ${
                        shareFrame ? 'translate-x-5.5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* When guests can save the album */}
                <div className="p-3.5 bg-black/40 border border-white/5 rounded-xl flex flex-col gap-2.5">
                  <div>
                    <p className="text-xs font-bold text-white">Guests can save the album</p>
                    <p className="text-[10px] text-g2-muted mt-0.5">
                      {ALBUM_SAVING_OPTIONS.find((o) => o.id === albumSaving)?.hint}. Their own photos are always theirs to save.
                    </p>
                  </div>
                  <div role="radiogroup" aria-label="Guests can save the album" className="grid grid-cols-3 gap-1.5">
                    {ALBUM_SAVING_OPTIONS.map((o) => (
                      <button
                        key={o.id}
                        role="radio"
                        aria-checked={albumSaving === o.id}
                        onClick={() => handleAlbumSaving(o.id)}
                        className={`h-9 px-2 rounded-lg text-[11px] font-bold cursor-pointer transition-colors ${
                          albumSaving === o.id ? 'bg-g2-blue text-white' : 'bg-white/5 border border-white/10 text-g2-secondary hover:text-white'
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  {savingMsg && <p className="text-[10px] text-red-400">{savingMsg}</p>}
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
                  <a href={joinLink} target="_blank" rel="noreferrer" className="text-g2-muted hover:text-white shrink-0" aria-label="Open the guest view">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
                <p className="text-[11px] text-g2-muted">
                  Or enter code <span className="font-mono font-bold text-white tracking-[0.12em]">{event.joinCode}</span> at {window.location.host}
                </p>
              </div>
              <HostShareButtons eventName={event.name} code={event.joinCode} url={joinLink} />
              <button
                type="button"
                onClick={handleResetJoinLink}
                disabled={resettingLink}
                className="w-full h-10 rounded-xl border border-white/10 text-g2-secondary hover:text-white hover:bg-white/5 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60 disabled:cursor-default transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${resettingLink ? 'animate-spin' : ''}`} aria-hidden="true" />
                {resettingLink ? 'Making a new link…' : 'Make a new join link'}
              </button>
              <p className="text-[10px] text-g2-muted leading-relaxed">
                Use this if the link ends up somewhere public. The old link stops working; guests already in stay in.
              </p>
            </div>


            {canDelete && (
              <div className="glass-card border border-red-500/20 rounded-2xl p-5 shadow-lg space-y-3">
                <h3 className="text-sm font-extrabold uppercase tracking-wider text-red-300">Delete event</h3>
                <p className="text-xs text-g2-tertiary leading-relaxed">
                  Removes the event for everyone: every photo, the guest list, Share Spots and the join link. This can't be undone.
                </p>
                {!deleteOpen ? (
                  <button
                    type="button"
                    onClick={() => { setDeleteOpen(true); setDeleteText(''); setDeleteMsg(''); }}
                    className="w-full h-10 rounded-xl border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-bold cursor-pointer transition-colors"
                  >
                    Delete this event…
                  </button>
                ) : (
                  <div className="space-y-2">
                    <label htmlFor="delete-confirm" className="block text-[11px] text-g2-secondary">
                      Type <span className="font-bold text-white">{event.name}</span> to confirm.
                    </label>
                    <input
                      id="delete-confirm"
                      type="text"
                      value={deleteText}
                      onChange={(e) => setDeleteText(e.target.value)}
                      autoComplete="off"
                      disabled={deleting}
                      className="w-full bg-black/40 border border-red-500/30 focus:border-red-400 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setDeleteOpen(false)}
                        disabled={deleting}
                        className="flex-1 h-10 rounded-xl border border-white/10 text-g2-secondary hover:text-white text-xs font-bold cursor-pointer disabled:opacity-60"
                      >
                        Keep it
                      </button>
                      <button
                        type="button"
                        onClick={handleDeleteEvent}
                        disabled={deleting || deleteText.trim() !== event.name.trim()}
                        className="flex-1 h-10 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold cursor-pointer disabled:opacity-40 disabled:cursor-default"
                      >
                        {deleting ? 'Deleting…' : 'Delete forever'}
                      </button>
                    </div>
                  </div>
                )}
                {deleteMsg && <p className="text-[11px] text-g2-secondary" aria-live="polite">{deleteMsg}</p>}
              </div>
            )}

            <CoHostsPanel uid={sessionId} isAdmin={isAdmin} limit={COHOST_LIMITS[tier]} tier={tier} />

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

                {/* Calendar invite */}
                <div className="border border-white/5 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleTip('calendar')}
                    className="w-full bg-black/20 hover:bg-black/40 p-3 flex justify-between items-center text-xs font-bold text-g2-secondary cursor-pointer"
                  >
                    <span>Calendar invite with the link</span>
                    {openTipId === 'calendar' ? <ChevronUp className="w-4 h-4 text-g2-muted" /> : <ChevronDown className="w-4 h-4 text-g2-muted" />}
                  </button>
                  {openTipId === 'calendar' && (
                    <div className="p-3.5 bg-black/40 text-[11px] text-g2-tertiary leading-relaxed border-t border-white/5 space-y-1.5">
                      <p>Send a calendar invite for your event, with the venue address as the location.</p>
                      <p className="text-g2-muted">Paste this link in the description: <span className="text-g2-blue-light font-mono">{joinLink}</span></p>
                      <p>When the reminder goes off, guests already have the link on their phone and can join with one tap.</p>
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
                <span className="ml-3 text-right text-[10px] text-g2-muted font-medium normal-case tracking-normal">Any spare phone or tablet on a stand</span>
              </h3>

              <AddShareSpot full={tripods.length >= deviceLimit ? <PlanLimitNote tier={tier} one="Share Spot" many="Share Spots" /> : undefined} />

              {tripods.length === 0 ? (
                <div className="p-6 bg-black/30 border border-white/5 rounded-xl text-center text-g2-muted text-xs">
                  No Share Spots yet. Tap “Add a Share Spot,” then enter the code on the device you want to use.
                </div>
              ) : (
                <div className="grid grid-cols-2 xl:grid-cols-3 gap-3 items-start">
                  {tripods.map((tripod) => (
                    <ShareSpotTile
                      key={tripod.sessionId}
                      spot={tripod}
                      shot={shots[tripod.sessionId]}
                      liveness={spotLiveness(tripod.sessionId)}
                      focused={focusSpot === tripod.sessionId}
                      onFire={() => fireShutter(tripod.sessionId)}
                      onToggleFocus={() => setFocusSpot(focusSpot === tripod.sessionId ? null : tripod.sessionId)}
                      onRemove={() => handleRemoveShareSpot(tripod)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* TV screens paired to this event */}
            <ScreensPanel hostUid={sessionId} limit={deviceLimit} full={<PlanLimitNote tier={tier} one="TV" many="TVs" />} />

            {/* AI Walkthrough video (hidden until config/walkthrough turns it on) */}
            <WalkthroughPanel photos={photos} />

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
                    title="Clear guests who haven't had the app open for 15 minutes from this list. They stay in the event."
                  >
                    <UserX className="w-3 h-3 text-red-400" /> Clear idle guests
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
                              {!(event.hostUids || []).includes(guest.sessionId) && (
                                <button
                                  onClick={() => { setRemoveError(''); setRemoveTarget({ sessionId: guest.sessionId, nickname: guest.nickname }); }}
                                  className="p-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-md text-[10px] font-bold transition-colors cursor-pointer"
                                  title="Remove or block this guest" aria-label={`Remove or block ${guest.nickname}`}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
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

              {guestNote && (
                <p className="text-[11px] text-g2-secondary flex items-start justify-between gap-3" aria-live="polite">
                  <span>{guestNote}</span>
                  <button onClick={() => setGuestNote('')} className="text-g2-muted hover:text-white cursor-pointer shrink-0" aria-label="Dismiss">
                    <X className="w-3 h-3" />
                  </button>
                </p>
              )}

              {blockedGuests.length > 0 && (
                <div className="border-t border-white/5 pt-3 space-y-2">
                  <p className="text-[10px] font-extrabold uppercase tracking-wider text-g2-muted">Blocked ({blockedGuests.length})</p>
                  {blockedGuests.map((b) => (
                    <div key={b.uid} className="flex items-center justify-between gap-3 bg-black/30 border border-white/5 px-3 py-2 rounded-lg">
                      <span className="text-xs text-g2-secondary truncate">{b.nickname}</span>
                      <button
                        onClick={() => handleUnblockGuest(b.uid, b.nickname)}
                        className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-g2-secondary font-bold px-2.5 py-1 rounded-lg cursor-pointer transition-colors shrink-0"
                      >
                        Unblock
                      </button>
                    </div>
                  ))}
                  <p className="text-[10px] text-g2-muted">A block is for that phone or browser. Someone determined could still join from another device.</p>
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
                          className="bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-400 font-bold px-2.5 py-1.5 rounded-xl text-[10px] font-bold flex flex-col items-center gap-0.5 min-w-[3.25rem] cursor-pointer transition-colors"
                          title="Delete for everyone. This can't be undone." aria-label="Delete photo"
                        >
                          <Trash2 className="w-4 h-4" />
                          <span>Delete</span>
                        </button>
                        <button
                          onClick={() => handleRejectPhoto(photo.id)}
                          className="bg-white/5 hover:bg-red-500/10 hover:text-red-400 border border-white/10 text-g2-tertiary px-2.5 py-1.5 rounded-xl text-[10px] font-bold flex flex-col items-center gap-0.5 min-w-[3.25rem] cursor-pointer transition-colors"
                          title="Hide from the gallery. You can restore it under Hidden photos." aria-label="Hide photo"
                        >
                          <EyeOff className="w-4 h-4" />
                          <span>Hide</span>
                        </button>
                        <button
                          onClick={() => handleApprovePhoto(photo.id)}
                          className="bg-emerald-500/25 hover:bg-emerald-500/35 border border-emerald-500/30 text-emerald-400 font-bold px-2.5 py-1.5 rounded-xl text-[10px] font-bold flex flex-col items-center gap-0.5 min-w-[3.25rem] cursor-pointer"
                          title="Clear report and approve" aria-label="Clear report and approve"
                        >
                          <Check className="w-4 h-4" />
                          <span>Approve</span>
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
                          className="bg-red-600/20 hover:bg-red-600/40 border border-red-500/40 text-red-400 font-bold px-2.5 py-1.5 rounded-xl text-[10px] font-bold flex flex-col items-center gap-0.5 min-w-[3.25rem] cursor-pointer transition-colors"
                          title="Delete for everyone. This can't be undone." aria-label="Delete photo"
                        >
                          <Trash2 className="w-4 h-4" />
                          <span>Delete</span>
                        </button>
                        <button
                          onClick={() => handleRejectPhoto(photo.id)}
                          className="bg-white/5 hover:bg-red-500/10 hover:text-red-400 border border-white/10 text-g2-tertiary px-2.5 py-1.5 rounded-xl text-[10px] font-bold flex flex-col items-center gap-0.5 min-w-[3.25rem] cursor-pointer transition-colors"
                          title="Hide from the gallery. You can restore it under Hidden photos." aria-label="Hide photo"
                        >
                          <EyeOff className="w-4 h-4" />
                          <span>Hide</span>
                        </button>
                        <button
                          onClick={() => handleApprovePhoto(photo.id)}
                          className="bg-g2-blue hover:bg-g2-blue-hover text-white font-extrabold px-2.5 py-1.5 rounded-xl text-[10px] font-bold flex flex-col items-center gap-0.5 min-w-[3.25rem] cursor-pointer transition-all duration-300 shadow-md shadow-g2-blue/20"
                          title="Approve" aria-label="Approve"
                        >
                          <Check className="w-4 h-4" />
                          <span>Approve</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Live gallery: everything guests can see right now */}
            <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center gap-1.5">
                  <ImageIcon className="w-4 h-4 text-g2-blue-light" /> Live gallery ({approvedPhotos.length})
                </h3>
                {onOpenGallery ? (
                  <button
                    type="button"
                    onClick={onOpenGallery}
                    className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-g2-secondary font-bold px-2.5 py-1 rounded-lg flex items-center gap-1 transition-colors cursor-pointer"
                  >
                    <Images className="w-3 h-3" /> Open gallery
                  </button>
                ) : (
                <a
                  href={joinLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-g2-secondary font-bold px-2.5 py-1 rounded-lg flex items-center gap-1 transition-colors"
                >
                  <ExternalLink className="w-3 h-3" /> Open guest view
                </a>
                )}
              </div>
              {approvedPhotos.length === 0 ? (
                <div className="p-6 bg-black/30 border border-white/5 rounded-xl text-center text-g2-muted text-xs">
                  No photos in the gallery yet.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                    {approvedPhotos.slice(0, galleryLimit).map((photo) => (
                      <div key={photo.id} className="relative aspect-square rounded-lg overflow-hidden bg-black/40 border border-white/5 group">
                        <img src={photo.url} alt={`Photo from ${photo.nickname}`} loading="lazy" className="w-full h-full object-cover" />
                        <span className="absolute left-1 bottom-1 max-w-[85%] truncate text-[9px] font-mono font-bold bg-black/70 text-white px-1.5 py-0.5 rounded">
                          {photo.nickname.replace(/\s*\((Tripod|Photo Spot|Share Spot|Group Shot)\)$/, '')}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleDeletePhoto(photo.id)}
                          aria-label={`Delete photo from ${photo.nickname}`}
                          title="Delete for everyone"
                          className="absolute top-1 right-1 p-1.5 rounded-md bg-black/70 text-g2-secondary hover:text-red-300 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {approvedPhotos.length > galleryLimit && (
                    <button
                      type="button"
                      onClick={() => setGalleryLimit((n) => n + 24)}
                      className="w-full h-10 rounded-xl border border-white/10 text-g2-secondary hover:text-white hover:bg-white/5 text-xs font-bold cursor-pointer transition-colors"
                    >
                      Show more ({approvedPhotos.length - galleryLimit} more)
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Hidden photos: turned down in review, or hidden when their guest was blocked */}
            {hiddenPhotos.length > 0 && (
              <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
                <div className="flex justify-between items-center flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setHiddenOpen((o) => !o)}
                    aria-expanded={hiddenOpen}
                    className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors"
                  >
                    <EyeOff className="w-4 h-4 text-g2-blue-light" /> Hidden photos ({hiddenPhotos.length})
                    {hiddenOpen ? <ChevronUp className="w-4 h-4 text-g2-muted" /> : <ChevronDown className="w-4 h-4 text-g2-muted" />}
                  </button>
                  {hiddenOpen && (
                    <button
                      type="button"
                      onClick={handleRestoreAllHidden}
                      disabled={restoringAll}
                      className="text-[10px] bg-white/5 hover:bg-white/10 border border-white/10 text-g2-secondary font-bold px-2.5 py-1 rounded-lg flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <Undo2 className="w-3 h-3" /> {restoringAll ? 'Restoring…' : 'Restore all'}
                    </button>
                  )}
                </div>
                {hiddenOpen && (
                  <>
                    <p className="text-[11px] text-g2-tertiary">
                      Guests can't see these. They were turned down in review, or hidden when their guest was blocked. Restore puts a photo back in the gallery.
                    </p>
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                      {hiddenPhotos.slice(0, hiddenLimit).map((photo) => (
                        <div key={photo.id} className="relative aspect-square rounded-lg overflow-hidden bg-black/40 border border-white/5">
                          <img src={photo.url} alt={`Hidden photo from ${photo.nickname}`} loading="lazy" className="w-full h-full object-cover opacity-60" />
                          <span className="absolute left-1 top-1 max-w-[85%] truncate text-[9px] font-mono font-bold bg-black/70 text-white px-1.5 py-0.5 rounded">
                            {photo.nickname.replace(/\s*\((Tripod|Photo Spot|Share Spot|Group Shot)\)$/, '')}
                          </span>
                          <div className="absolute inset-x-1 bottom-1 flex gap-1">
                            <button
                              type="button"
                              onClick={() => handleRestorePhoto(photo.id)}
                              aria-label={`Restore photo from ${photo.nickname}`}
                              className="flex-1 flex items-center justify-center gap-1 py-1 rounded-md bg-g2-blue text-white text-[10px] font-bold cursor-pointer hover:opacity-90"
                            >
                              <Undo2 className="w-3 h-3" /> Restore
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeletePhoto(photo.id)}
                              aria-label={`Delete photo from ${photo.nickname}`}
                              title="Delete for everyone"
                              className="p-1.5 rounded-md bg-black/70 text-g2-secondary hover:text-red-300 cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {hiddenPhotos.length > hiddenLimit && (
                      <button
                        type="button"
                        onClick={() => setHiddenLimit((n) => n + 24)}
                        className="w-full h-10 rounded-xl border border-white/10 text-g2-secondary hover:text-white hover:bg-white/5 text-xs font-bold cursor-pointer transition-colors"
                      >
                        Show more ({hiddenPhotos.length - hiddenLimit} more)
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Remove or block a guest */}
      {removeTarget && (
        <div
          className="fixed inset-0 z-[70] bg-g2-page/80 flex items-center justify-center p-4 font-sans"
          role="dialog" aria-modal="true" aria-label={`Remove or block ${removeTarget.nickname}`}
          onClick={() => { if (!removeBusy) setRemoveTarget(null); }}
        >
          <div className="glass-card border border-white/10 rounded-2xl p-5 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 className="text-sm font-extrabold text-white">Remove {removeTarget.nickname}?</h3>
              <p className="text-[11px] text-g2-tertiary mt-1">Their phone goes back to the join screen.</p>
            </div>
            <div className="space-y-2">
              <button
                onClick={() => handleRemoveGuest('remove')}
                disabled={removeBusy}
                className="w-full text-left bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl px-3.5 py-2.5 cursor-pointer disabled:opacity-50 transition-colors"
              >
                <span className="block text-xs font-bold text-white">Remove</span>
                <span className="block text-[11px] text-g2-tertiary">They can join again with the code. Their photos stay.</span>
              </button>
              <button
                onClick={() => handleRemoveGuest('block')}
                disabled={removeBusy}
                className="w-full text-left bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl px-3.5 py-2.5 cursor-pointer disabled:opacity-50 transition-colors"
              >
                <span className="block text-xs font-bold text-red-300">Block, keep their photos</span>
                <span className="block text-[11px] text-g2-tertiary">That phone can't join this event again.</span>
              </button>
              <button
                onClick={() => handleRemoveGuest('blockHide')}
                disabled={removeBusy}
                className="w-full text-left bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-xl px-3.5 py-2.5 cursor-pointer disabled:opacity-50 transition-colors"
              >
                <span className="block text-xs font-bold text-red-300">Block, hide their photos</span>
                <span className="block text-[11px] text-g2-tertiary">Also takes their photos out of the gallery. You can restore them later under Hidden photos.</span>
              </button>
            </div>
            {removeError && <p className="text-[11px] text-red-400" aria-live="polite">{removeError}</p>}
            <button
              onClick={() => setRemoveTarget(null)}
              disabled={removeBusy}
              className="w-full text-xs font-bold text-g2-secondary hover:text-white py-2 cursor-pointer disabled:opacity-50"
            >
              {removeBusy ? 'Working…' : 'Cancel'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

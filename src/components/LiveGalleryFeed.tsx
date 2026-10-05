import React, { useState, useEffect, useRef } from 'react';
import { Camera, Heart, Image as ImageIcon, LogOut, Clock, RefreshCw, Trash2, Bookmark } from 'lucide-react';
import Get2ShareLockup from './Get2ShareLockup';
import { query, where, onSnapshot, addDoc, getDoc, updateDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { eventPhase, expiryOf, formatDay, paths } from '../events';
import { useEvent } from '../EventContext';
import { deletePhotoFile, compressPhoto, uploadPhotoAsset, handleFirestoreError, OperationType } from '../firebase';
import { Photo } from '../types';
import { motion, AnimatePresence } from 'motion/react';

interface LiveGalleryFeedProps {
  sessionId: string;
  nickname: string;
  onOpenLightbox: (photo: Photo) => void;
  onExitSession: () => void;
  /** Sign this device out and join again as a new guest (shared or test devices). */
  onJoinAsNew?: () => void;
  favorites: string[];
  hiddenIds: string[];
  onGoToHost: () => void;
  onOpenKeepsake: () => void;
  /** This phone's photos are already saved to an account. */
  isSaved?: boolean;
  eventTitle?: string;
  eventSubtitle?: string;
  isHost?: boolean;
}

export default function LiveGalleryFeed({
  sessionId,
  nickname,
  onOpenLightbox,
  onExitSession,
  onJoinAsNew,
  favorites,
  hiddenIds,
  onGoToHost,
  onOpenKeepsake,
  isSaved = false,
  eventTitle,
  eventSubtitle,
  isHost,
}: LiveGalleryFeedProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [activeTab, setActiveTab] = useState<'all' | 'my' | 'favorites'>('all');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const { event } = useEvent();
  const eventId = event.id;
  const autoApproval = event.autoApproval;

  // Where the event is in its life (live → wrap-up → album). Re-checked every 30s.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);
  const phase = eventPhase(event, now);
  const uploadsOpen = phase === 'live' || phase === 'wrapup';
  const endMs = event.endsAt?.toMillis?.() ?? null;
  const albumUntil = event.expireAt?.toMillis?.() ?? null;

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 1. Listen in real time to approved photos + this device's own uploads.
  //    (The database rules only let guests read those two sets, so the
  //    queries must ask for exactly them.)
  const [approvedPhotos, setApprovedPhotos] = useState<Photo[]>([]);
  const [myPhotos, setMyPhotos] = useState<Photo[]>([]);

  useEffect(() => {
    const toPhotos = (snap: any): Photo[] => {
      const docs: Photo[] = [];
      snap.forEach((d: any) => docs.push({ id: d.id, ...d.data() } as Photo));
      return docs;
    };

    const unsubApproved = onSnapshot(
      query(paths.photos(eventId), where('status', '==', 'approved')),
      (snap) => setApprovedPhotos(toPhotos(snap)),
      (err) => console.error('Error fetching approved photos:', err)
    );

    const unsubMine = sessionId
      ? onSnapshot(
          query(paths.photos(eventId), where('sessionId', '==', sessionId)),
          (snap) => setMyPhotos(toPhotos(snap)),
          (err) => console.error('Error fetching my photos:', err)
        )
      : () => {};

    return () => {
      unsubApproved();
      unsubMine();
    };
  }, [sessionId, eventId]);

  useEffect(() => {
    const byId = new Map<string, Photo>();
    [...approvedPhotos, ...myPhotos].forEach((p) => byId.set(p.id, p));
    setPhotos(Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  }, [approvedPhotos, myPhotos]);

  // 3. Keep guest session "active" heartbeat updated
  useEffect(() => {
    if (!sessionId || !nickname) return;
    
    // Register or heartbeat current session
    const docRef = paths.session(eventId, sessionId);
    const updateHeartbeat = async () => {
      try {
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          await updateDoc(docRef, { lastActive: Date.now() });
        } else {
          // Create session with the custom sessionId document key
          await setDoc(docRef, {
            sessionId: sessionId,
            nickname: nickname,
            role: 'guest',
            lastActive: Date.now(),
            ...expiryOf(event),
          });
        }
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `sessions/${sessionId}`);
      }
    };

    updateHeartbeat();
    const interval = setInterval(updateHeartbeat, 15000); // 15s heartbeat
    return () => clearInterval(interval);
  }, [sessionId, nickname, eventId]);

  const handleUploadClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reject non-images (V1 photo-only policy)
    const validTypes = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/jpg'];
    if (!validTypes.includes(file.type) && !file.name.toLowerCase().endsWith('.heic')) {
      alert('Photos only, please (JPEG, PNG or HEIC).');
      return;
    }

    try {
      setUploading(true);
      setUploadProgress('Shrinking it for a fast upload…');

      // 1. Automatic client-side compression downscales to 1200px max-width, ~80% JPEG quality
      const compressedBlob = await compressPhoto(file);

      setUploadProgress('Uploading…');
      // 2. Upload to Cloud Storage with Base64 fallback
      const fileUrl = await uploadPhotoAsset(compressedBlob, file.name, eventId);

      setUploadProgress('Adding it to the gallery…');
      
      // Determine default status based on host settings
      const defaultStatus = (autoApproval || isHost) ? 'approved' : 'pending';

      // 3. Write document to Firestore
      try {
        await addDoc(paths.photos(eventId), {
          url: fileUrl,
          nickname: nickname,
          sessionId: sessionId,
          createdAt: Date.now(),
          status: defaultStatus,
          reactions: { likes: 0, dislikes: 0 },
          flagged: false,
          ...expiryOf(event),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, 'photos');
      }

      setUploadProgress(defaultStatus === 'pending' ? 'Sent to the host for review.' : 'Posted!');
      setTimeout(() => {
        setUploading(false);
        setUploadProgress('');
      }, 1000);
    } catch (err) {
      console.error('Photo submission failed:', err);
      alert("That photo didn't upload. Check your connection and try again.");
      setUploading(false);
      setUploadProgress('');
    }
  };

  // Filter photos based on tabs and local settings
  const filteredPhotos = photos.filter((p) => {
    // Hide locally flagged or hidden IDs
    if (hiddenIds.includes(p.id)) return false;

    if (activeTab === 'all') {
      return p.status === 'approved';
    }
    if (activeTab === 'my') {
      return p.sessionId === sessionId;
    }
    if (activeTab === 'favorites') {
      return favorites.includes(p.id) && p.status === 'approved';
    }
    return true;
  });

  const title = event.name || eventTitle || '';
  const subtitle = event.subtitle || eventSubtitle || '';
  const approvedCount = photos.filter((p) => p.status === 'approved').length;
  const hasPending = photos.some((p) => p.sessionId === sessionId && p.status === 'pending');

  const tabs: { id: 'all' | 'my' | 'favorites'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'my', label: 'Mine' },
    { id: 'favorites', label: `Loved${favorites.length ? ` (${favorites.length})` : ''}` },
  ];

  return (
    <div className="min-h-dvh bg-g2-page text-g2-text font-sans relative pb-36">
      {/* Header */}
      <header className="sticky top-0 bg-g2-page/90 backdrop-blur-md border-b border-white/[0.08] pl-5 pr-3 py-2.5 flex justify-between items-center z-30">
        <Get2ShareLockup className="text-[21px]" />
        <div className="flex items-center gap-1">
          <span className="h-[30px] max-w-[120px] px-3 inline-flex items-center rounded-full border border-white/10 font-mono text-[10.5px] font-bold text-g2-secondary truncate">
            @{nickname}
          </span>
          {isHost && (
            <button
              onClick={onGoToHost}
              className="h-11 px-2.5 font-mono text-[10.5px] font-bold tracking-[0.08em] uppercase text-g2-secondary hover:text-white transition-colors cursor-pointer"
            >
              Host Console
            </button>
          )}
          <button
            onClick={onOpenKeepsake}
            aria-label="Save my photos"
            title="Save my photos"
            className="w-11 h-11 flex items-center justify-center text-g2-secondary hover:text-white transition-colors cursor-pointer"
          >
            <Bookmark className="w-[18px] h-[18px]" />
          </button>
          <button
            onClick={onExitSession}
            aria-label="Leave event or change nickname"
            title="Leave event"
            className="w-11 h-11 flex items-center justify-center text-g2-secondary hover:text-red-400 transition-colors cursor-pointer"
          >
            <LogOut className="w-[18px] h-[18px]" />
          </button>
        </div>
      </header>

      {/* Event */}
      <section className="px-5 pt-4 pb-3 max-w-3xl mx-auto">
        <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary flex items-center gap-2">
          <span className={`w-[7px] h-[7px] rounded-full ${uploadsOpen ? 'bg-emerald-400' : 'bg-g2-muted'}`} />
          {phase === 'live' ? 'Live event' : phase === 'wrapup' ? 'Wrapping up' : 'Album'} · {approvedCount} {approvedCount === 1 ? 'photo' : 'photos'}
        </p>
        {title && (
          <h1 className="mt-1.5 font-expanded font-black text-2xl leading-tight text-white">{title}</h1>
        )}
        {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-g2-secondary">{subtitle}</p>}
        {onJoinAsNew && !isHost && (
          <button
            type="button"
            onClick={onJoinAsNew}
            className="mt-1.5 -ml-1 px-1 h-8 text-[12px] text-g2-tertiary hover:text-white underline underline-offset-2 cursor-pointer"
          >
            Not {nickname || 'you'}? Join as someone new
          </button>
        )}

        {phase === 'wrapup' && endMs && (
          <p className="mt-3 px-3.5 py-2.5 rounded-lg bg-amber-400/10 border border-amber-400/25 text-[13px] text-amber-100">
            The party's wrapping up. Last photos until {new Date(endMs + 60 * 60 * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
          </p>
        )}
        {!uploadsOpen && (
          <div className="mt-3 p-4 rounded-xl bg-g2-panel border border-g2-blue/40 flex flex-col gap-3">
            <div>
              <p className="text-[15px] font-bold text-white">That's a wrap.</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-g2-secondary">
                {albumUntil ? `This album is open until ${formatDay(albumUntil)}. ` : ''}
                {isSaved ? 'Your photos are saved to your account.' : 'Save your photos to keep them for good.'}
              </p>
            </div>
            <button
              onClick={onOpenKeepsake}
              className={`h-12 rounded-lg font-bold text-[15px] cursor-pointer transition-colors ${
                isSaved ? 'border border-white/15 text-white hover:bg-white/5' : 'bg-g2-blue hover:bg-g2-blue-hover text-white'
              }`}
            >
              {isSaved ? 'See my photos' : 'Save my photos'}
            </button>
          </div>
        )}
      </section>

      {/* Filters */}
      <nav aria-label="Gallery filter" className="px-5 pb-3 max-w-3xl mx-auto flex gap-2 overflow-x-auto">
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={active}
              className={`relative h-10 px-[18px] shrink-0 rounded-full text-[13px] transition-colors cursor-pointer ${
                active
                  ? 'bg-g2-text text-g2-page font-bold'
                  : 'border border-white/10 text-g2-secondary hover:text-white font-semibold'
              }`}
            >
              {tab.label}
              {tab.id === 'my' && hasPending && (
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-amber-400 rounded-full border-2 border-g2-page" aria-label="You have photos waiting for review" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Grid */}
      <main className="px-5 max-w-3xl mx-auto">
        {filteredPhotos.length === 0 ? (
          <div className="py-16 text-center">
            <div className="p-6 bg-g2-panel border border-white/[0.08] rounded-xl max-w-xs mx-auto">
              <ImageIcon className="w-9 h-9 text-g2-muted mx-auto mb-3" aria-hidden="true" />
              <p className="text-sm font-bold text-white">Nothing here yet</p>
              <p className="text-[13px] text-g2-tertiary mt-1 leading-relaxed">
                {activeTab === 'all'
                  ? 'Tap the shutter below to post the first photo of the night.'
                  : activeTab === 'my'
                  ? 'Photos you take tonight show up here.'
                  : 'Open any photo and tap the heart to keep it here.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="columns-2 sm:columns-3 gap-2 space-y-2">
            {filteredPhotos.map((photo) => {
              const isPending = photo.status === 'pending';
              const isRejected = photo.status === 'rejected';
              const fromSpot = /\((Tripod|Photo Spot|Share Spot)\)$/.test(photo.nickname);
              const fromLens = /\((Guest Lens|Group Shot)\)$/.test(photo.nickname);
              const shownName = photo.nickname.replace(/\s*\((Tripod|Photo Spot|Share Spot|Guest Lens|Group Shot)\)$/, '');

              return (
                <div
                  key={photo.id}
                  onClick={() => onOpenLightbox(photo)}
                  className={`break-inside-avoid bg-g2-panel rounded-[10px] border border-white/[0.08] overflow-hidden relative cursor-pointer group ${
                    isPending ? 'opacity-60' : ''
                  } ${isRejected ? 'opacity-30' : ''}`}
                >
                  <img
                    src={photo.url}
                    alt={`Photo by ${shownName}`}
                    className="w-full object-cover max-h-72"
                    loading="lazy"
                  />

                  <div className="absolute inset-x-0 bottom-0 h-8 px-2.5 flex items-center justify-between bg-g2-page/80 font-mono text-[10px] text-g2-secondary">
                    <span className="truncate">{fromSpot ? `Spot · ${shownName}` : `@${shownName}`}</span>
                    {(photo.reactions?.likes ?? 0) > 0 && (
                      <span className="flex items-center gap-1 shrink-0">
                        <Heart className="w-3 h-3" aria-hidden="true" /> {photo.reactions.likes}
                      </span>
                    )}
                  </div>

                  {/* Host delete */}
                  {isHost && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm('Delete this photo from the event for everyone?')) {
                          deleteDoc(paths.photo(eventId, photo.id)).then(() => deletePhotoFile(photo.url)).catch((err) => {
                            console.error('Host delete failed:', err);
                            handleFirestoreError(err, OperationType.DELETE, `photos/${photo.id}`);
                          });
                        }
                      }}
                      aria-label="Delete photo"
                      className="absolute top-2 right-2 w-8 h-8 flex items-center justify-center bg-g2-page/80 hover:bg-red-600 text-white rounded-lg border border-white/10 z-20 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Badges */}
                  <div className="absolute top-2 left-2 flex flex-wrap gap-1 pr-10">
                    {fromSpot && (
                      <span className="h-[22px] px-2 inline-flex items-center rounded-full bg-g2-page/80 border border-g2-blue-light text-g2-blue-light font-mono text-[9.5px] font-bold tracking-[0.06em] uppercase">
                        Share Spot
                      </span>
                    )}
                    {fromLens && (
                      <span className="h-[22px] px-2 inline-flex items-center rounded-full bg-g2-page/80 border border-white text-white font-mono text-[9.5px] font-bold tracking-[0.06em] uppercase">
                        Group Shot
                      </span>
                    )}
                    {isPending && (
                      <span className="h-[22px] px-2 inline-flex items-center gap-1 rounded-full bg-g2-page/80 border border-g2-tertiary text-g2-secondary font-mono text-[9.5px] font-bold tracking-[0.06em] uppercase">
                        <Clock className="w-2.5 h-2.5" aria-hidden="true" /> Pending review
                      </span>
                    )}
                    {isRejected && (
                      <span className="h-[22px] px-2 inline-flex items-center rounded-full bg-red-600 text-white font-mono text-[9.5px] font-bold tracking-[0.06em] uppercase">
                        Declined
                      </span>
                    )}
                    {favorites.includes(photo.id) && (
                      <span className="w-[22px] h-[22px] inline-flex items-center justify-center rounded-full bg-g2-page/80 border border-white/20" aria-label="Loved">
                        <Heart className="w-3 h-3 fill-white text-white" />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Shutter bar */}
      <div className="fixed bottom-0 inset-x-0 z-40 bg-g2-page border-t border-white/[0.08] pb-[env(safe-area-inset-bottom)]">
        <AnimatePresence>
          {uploading && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="absolute bottom-full mb-3 inset-x-4 max-w-sm mx-auto bg-g2-panel border border-white/10 p-3.5 rounded-xl shadow-2xl flex items-center gap-3"
            >
              <RefreshCw className="w-5 h-5 animate-spin text-g2-blue-light shrink-0" aria-hidden="true" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-white">Posting your photo…</p>
                <p className="text-[11px] text-g2-tertiary mt-0.5 truncate">{uploadProgress}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="h-28 flex flex-col items-center justify-center gap-1.5">
          {!uploadsOpen ? (
            <p className="px-6 text-center text-[13px] text-g2-tertiary">
              New photos are closed for this event.
            </p>
          ) : (
          <button
            onClick={handleUploadClick}
            disabled={uploading}
            aria-label="Add a photo: take one or choose from your photos"
            className="w-[76px] h-[76px] rounded-full border-[3px] border-white p-[5px] active:scale-95 transition-transform disabled:opacity-50 cursor-pointer"
          >
            <span className="flex w-full h-full rounded-full bg-white items-center justify-center text-g2-page">
              <Camera className="w-[26px] h-[26px]" aria-hidden="true" />
            </span>
          </button>
          )}
        </div>

        {/* Hidden native input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>
    </div>
  );
}

import React, { useState, useEffect, useRef } from 'react';
import { Camera, Heart, Eye, Image as ImageIcon, Sparkles, LogOut, CheckCircle, Clock, RefreshCw, Trash2 } from 'lucide-react';
import { collection, query, onSnapshot, orderBy, addDoc, doc, getDoc, updateDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { db, compressPhoto, uploadPhotoAsset, handleFirestoreError, OperationType } from '../firebase';
import { Photo } from '../types';
import { motion, AnimatePresence } from 'motion/react';

interface LiveGalleryFeedProps {
  sessionId: string;
  nickname: string;
  onOpenLightbox: (photo: Photo) => void;
  onExitSession: () => void;
  favorites: string[];
  hiddenIds: string[];
  onGoToHost: () => void;
  eventTitle?: string;
  eventSubtitle?: string;
  isHost?: boolean;
}

export default function LiveGalleryFeed({
  sessionId,
  nickname,
  onOpenLightbox,
  onExitSession,
  favorites,
  hiddenIds,
  onGoToHost,
  eventTitle,
  eventSubtitle,
  isHost,
}: LiveGalleryFeedProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [activeTab, setActiveTab] = useState<'all' | 'my' | 'favorites'>('all');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [autoApproval, setAutoApproval] = useState(true);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 1. Listen for ALL photos in real time
  useEffect(() => {
    const q = query(collection(db, 'photos'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snap) => {
      const docs: Photo[] = [];
      snap.forEach((doc) => {
        docs.push({ id: doc.id, ...doc.data() } as Photo);
      });
      setPhotos(docs);
    }, (err) => {
      console.error('Error fetching gallery live feed:', err);
      handleFirestoreError(err, OperationType.LIST, 'photos');
    });

    return () => unsubscribe();
  }, []);

  // 2. Listen to auto approval settings to know if we should display pending badge
  useEffect(() => {
    const docRef = doc(db, 'settings', 'event-settings');
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        setAutoApproval(snap.data().autoApproval);
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'settings/event-settings');
    });

    return () => unsubscribe();
  }, []);

  // 3. Keep guest session "active" heartbeat updated
  useEffect(() => {
    if (!sessionId || !nickname) return;
    
    // Register or heartbeat current session
    const docRef = doc(db, 'sessions', sessionId);
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
          });
        }
      } catch (e) {
        handleFirestoreError(e, OperationType.WRITE, `sessions/${sessionId}`);
      }
    };

    updateHeartbeat();
    const interval = setInterval(updateHeartbeat, 15000); // 15s heartbeat
    return () => clearInterval(interval);
  }, [sessionId, nickname]);

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
      alert('Please upload photo assets only (JPEG, PNG, HEIC) to ensure fast event streaming.');
      return;
    }

    try {
      setUploading(true);
      setUploadProgress('Compressing image on client-side...');

      // 1. Automatic client-side compression downscales to 1200px max-width, ~80% JPEG quality
      const compressedBlob = await compressPhoto(file);

      setUploadProgress('Uploading to secure cloud host...');
      // 2. Upload to Cloud Storage with Base64 fallback
      const fileUrl = await uploadPhotoAsset(compressedBlob, file.name);

      setUploadProgress('Publishing snap...');
      
      // Determine default status based on host settings
      const defaultStatus = autoApproval ? 'approved' : 'pending';

      // 3. Write document to Firestore
      try {
        await addDoc(collection(db, 'photos'), {
          url: fileUrl,
          nickname: nickname,
          sessionId: sessionId,
          createdAt: Date.now(),
          status: defaultStatus,
          reactions: { likes: 0, dislikes: 0 },
          flagged: false,
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, 'photos');
      }

      setUploadProgress('Success!');
      setTimeout(() => {
        setUploading(false);
        setUploadProgress('');
      }, 1000);
    } catch (err) {
      console.error('Photo submission failed:', err);
      alert('Upload failed. Please try again on a better connection.');
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

  return (
    <div className="min-h-screen bg-[#050505] text-slate-100 font-sans relative pb-28">
      {/* Top Header Navigation */}
      <header className="sticky top-0 bg-[#050505]/85 backdrop-blur-md border-b border-white/5 px-4 py-4.5 flex justify-between items-center z-30">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-gradient-to-tr from-[#00f2ff] to-blue-600 rounded-lg">
            <Camera className="w-5 h-5 text-slate-950" />
          </div>
          <span className="font-extrabold text-lg bg-gradient-to-r from-[#00f2ff] to-blue-400 bg-clip-text text-transparent">
            Get2Share
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={onGoToHost}
            className="text-[11px] font-bold bg-white/5 border border-white/10 hover:border-[#00f2ff]/40 text-slate-300 hover:text-[#00f2ff] px-3 py-1.5 rounded-lg transition-all duration-300 cursor-pointer backdrop-blur-sm"
          >
            Host Panel
          </button>
          <button
            onClick={onExitSession}
            className="p-1.5 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-red-400 rounded-lg border border-white/10 transition-all duration-300 cursor-pointer"
            title="Leave Event"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Hero Header Context */}
      <div className="px-4 py-6 max-w-2xl mx-auto space-y-1.5 text-center">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#00f2ff]/5 border border-[#00f2ff]/20 rounded-full text-[#00f2ff] text-[10px] font-bold uppercase tracking-wider shadow-[0_0_10px_rgba(0,242,255,0.05)]">
          <Sparkles className="w-3 h-3" /> Event Live
        </div>
        <h1 className="text-xl font-extrabold text-white">{eventTitle || 'Summer Gala 2026'}</h1>
        <p className="text-xs text-slate-400 font-light flex items-center justify-center gap-1.5 flex-wrap">
          <span>Logged in as <span className="font-bold text-[#00f2ff]">{nickname}</span></span>
          <button
            onClick={onExitSession}
            className="text-[10px] text-red-400 hover:text-red-300 underline font-semibold px-1 py-0.5 rounded hover:bg-red-500/10 transition-all cursor-pointer"
          >
            (Switch Name / Clear Data)
          </button>
          <span>&bull; {eventSubtitle || 'Tap any photo to react!'}</span>
        </p>
      </div>

      {/* Tabs */}
      <div className="px-4 max-w-2xl mx-auto mb-6">
        <div className="bg-white/5 border border-white/10 p-1.5 rounded-2xl flex gap-1 backdrop-blur-sm">
          <button
            onClick={() => setActiveTab('all')}
            className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all duration-300 cursor-pointer ${
              activeTab === 'all'
                ? 'bg-[#00f2ff] text-slate-950 shadow-md shadow-[#00f2ff]/20'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            All Snaps
          </button>
          <button
            onClick={() => setActiveTab('my')}
            className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all duration-300 cursor-pointer relative ${
              activeTab === 'my'
                ? 'bg-[#00f2ff] text-slate-950 shadow-md shadow-[#00f2ff]/20'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            My Uploads
            {photos.some((p) => p.sessionId === sessionId && p.status === 'pending') && (
              <span className="absolute top-1 right-2 w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('favorites')}
            className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all duration-300 cursor-pointer ${
              activeTab === 'favorites'
                ? 'bg-[#00f2ff] text-slate-950 shadow-md shadow-[#00f2ff]/20'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Favorites ({favorites.length})
          </button>
        </div>
      </div>

      {/* Responsive Grid Gallery */}
      <main className="px-4 max-w-3xl mx-auto">
        {filteredPhotos.length === 0 ? (
          <div className="py-20 text-center space-y-3">
            <div className="p-4 bg-slate-900/40 border border-slate-900 rounded-3xl max-w-xs mx-auto">
              <ImageIcon className="w-10 h-10 text-slate-700 mx-auto mb-2" />
              <p className="text-sm font-bold text-slate-300">No photos in this view</p>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                {activeTab === 'all'
                  ? 'Be the first to snap a dynamic photo and share it live!'
                  : activeTab === 'my'
                  ? 'Photos you upload at the event will appear here.'
                  : 'Tap the heart icon in any photo lightbox to save favorites.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="columns-2 sm:columns-3 gap-3 space-y-3">
            {filteredPhotos.map((photo) => {
              const isPending = photo.status === 'pending';
              const isRejected = photo.status === 'rejected';

              return (
                <div
                  key={photo.id}
                  onClick={() => onOpenLightbox(photo)}
                  className={`break-inside-avoid bg-[#121212]/40 rounded-2xl border border-white/5 overflow-hidden relative cursor-pointer group transition-all duration-300 hover:scale-[1.01] hover:shadow-lg hover:shadow-[#00f2ff]/10 ${
                    isPending ? 'opacity-50 border-amber-500/20' : ''
                  } ${isRejected ? 'opacity-30 border-red-500/20' : ''}`}
                >
                  <img
                    src={photo.url}
                    alt={`Snap by ${photo.nickname}`}
                    className="w-full object-cover max-h-72"
                    loading="lazy"
                  />

                  {/* Dark Vignette Overlay */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                    <p className="text-[10px] font-bold text-[#00f2ff] truncate">
                      By {photo.nickname}
                    </p>
                  </div>

                  {/* God-Mode Host Delete Button */}
                  {isHost && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm('Host God-Mode: Permanently delete this photo from the event?')) {
                          deleteDoc(doc(db, 'photos', photo.id)).catch((err) => {
                            console.error('God-mode delete failed:', err);
                            handleFirestoreError(err, OperationType.DELETE, `photos/${photo.id}`);
                          });
                        }
                      }}
                      className="absolute top-2 left-2 p-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg shadow-lg border border-red-400 z-20 flex items-center justify-center transition-transform hover:scale-110 cursor-pointer"
                      title="Host God-Mode: Delete Photo"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {/* Badge Indicators */}
                  <div className="absolute top-2 right-2 flex gap-1">
                    {/* Favorite badge */}
                    {favorites.includes(photo.id) && (
                      <span className="p-1 bg-rose-500/90 text-white rounded-lg backdrop-blur-sm">
                        <Heart className="w-3 h-3 fill-rose-100" />
                      </span>
                    )}

                    {/* Pending review badge */}
                    {isPending && (
                      <span className="text-[9px] bg-amber-500 text-slate-950 font-bold px-1.5 py-0.5 rounded-lg flex items-center gap-0.5 animate-pulse shadow-md">
                        <Clock className="w-2.5 h-2.5" /> Awaiting Host Review
                      </span>
                    )}

                    {/* Rejected review badge */}
                    {isRejected && (
                      <span className="text-[9px] bg-red-500 text-white font-bold px-1.5 py-0.5 rounded-lg shadow-md">
                        Declined
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Floating Upload Hub & Progress Display */}
      <div className="fixed bottom-6 inset-x-4 max-w-sm mx-auto z-40">
        <AnimatePresence>
          {uploading && (
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
              className="glass-card neon-border p-4 rounded-2xl shadow-2xl mb-3 flex items-center gap-3"
            >
              <div className="p-2 bg-[#00f2ff]/10 border border-[#00f2ff]/20 text-[#00f2ff] rounded-xl shadow-[0_0_10px_rgba(0,242,255,0.15)]">
                <RefreshCw className="w-5 h-5 animate-spin" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-white">Asset Lightweighting active</p>
                <p className="text-[10px] text-slate-400 mt-0.5 truncate">{uploadProgress}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          onClick={handleUploadClick}
          disabled={uploading}
          className="w-full bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-extrabold py-4 rounded-2xl shadow-xl shadow-[#00f2ff]/10 flex items-center justify-center gap-2 transition-all duration-300 active:scale-[0.98] cursor-pointer"
        >
          <Camera className="w-5.5 h-5.5 text-slate-950" />
          <span>Snap & Upload Event Photo</span>
        </button>

        {/* Hidden native input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>
    </div>
  );
}

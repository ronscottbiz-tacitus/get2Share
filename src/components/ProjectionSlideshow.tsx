import { useEffect, useState } from 'react';
import { Play, Pause, ChevronLeft, ChevronRight, Minimize, HelpCircle, QrCode } from 'lucide-react';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { Photo } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import QRCode from 'qrcode';

interface ProjectionSlideshowProps {
  onClose: () => void;
}

export default function ProjectionSlideshow({ onClose }: ProjectionSlideshowProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [rotationSpeed, setRotationSpeed] = useState(6000); // 6 seconds default
  const [showQrCode, setShowQrCode] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  // Generate QR code on mount
  useEffect(() => {
    QRCode.toDataURL(window.location.origin, {
      margin: 2,
      width: 150,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    })
    .then(url => setQrDataUrl(url))
    .catch(err => console.error('Error generating QR code in slideshow:', err));
  }, []);

  // 1. Listen for approved photos in real-time
  useEffect(() => {
    // Sorted on the device so no composite database index is needed.
    const q = query(
      collection(db, 'photos'),
      where('status', '==', 'approved')
    );

    const unsubscribe = onSnapshot(q, (snap) => {
      const docs: Photo[] = [];
      snap.forEach((doc) => {
        docs.push({ id: doc.id, ...doc.data() } as Photo);
      });
      docs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setPhotos(docs);
    }, (err) => {
      console.error('Error fetching approved photos for projection:', err);
    });

    return () => unsubscribe();
  }, []);

  // 2. Playback / rotation timer loop
  useEffect(() => {
    if (!isPlaying || photos.length <= 1) return;

    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % photos.length);
    }, rotationSpeed);

    return () => clearInterval(timer);
  }, [isPlaying, photos.length, rotationSpeed]);

  const handleNext = () => {
    if (photos.length === 0) return;
    setCurrentIndex((prev) => (prev + 1) % photos.length);
  };

  const handlePrev = () => {
    if (photos.length === 0) return;
    setCurrentIndex((prev) => (prev - 1 + photos.length) % photos.length);
  };

  const activePhoto = photos[currentIndex];

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col justify-between font-sans overflow-hidden select-none">
      {/* Projection Top HUD */}
      <div className="absolute top-0 inset-x-0 p-6 bg-gradient-to-b from-black/95 to-transparent flex justify-between items-center z-20">
        <div className="flex items-center gap-3">
          <div className="px-3 py-1.5 bg-[#00f2ff]/5 border border-[#00f2ff]/20 rounded-full text-xs font-bold text-[#00f2ff] flex items-center gap-1.5 shadow-lg">
            <span className="w-2.5 h-2.5 bg-[#00f2ff] rounded-full animate-ping" />
            LIVE SLIDESHOW
          </div>
          <span className="text-slate-400 text-xs font-medium">
            {photos.length} Photo{photos.length === 1 ? '' : 's'} Approved
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Speed settings */}
          <select
            value={rotationSpeed}
            onChange={(e) => setRotationSpeed(Number(e.target.value))}
            className="bg-white/5 text-slate-300 border border-white/10 px-3 py-1.5 rounded-xl text-xs font-medium focus:outline-none focus:border-[#00f2ff] cursor-pointer"
          >
            <option value={4000}>4s Fast</option>
            <option value={6000}>6s Med</option>
            <option value={10000}>10s Slow</option>
            <option value={15000}>15s Cinematic</option>
          </select>

          {/* Toggle instructions */}
          <button
            onClick={() => setShowQrCode(!showQrCode)}
            className={`p-2.5 rounded-xl border transition-all duration-300 cursor-pointer flex items-center gap-1.5 text-xs font-bold ${
              showQrCode
                ? 'bg-[#00f2ff] text-slate-950 border-[#00f2ff] shadow-md shadow-[#00f2ff]/20'
                : 'bg-white/5 border border-white/10 text-slate-400 hover:text-slate-200'
            }`}
          >
            <QrCode className="w-4 h-4" />
            Join Overlay
          </button>

          {/* Close/Minimize */}
          <button
            onClick={onClose}
            className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-slate-300 transition-all duration-300 cursor-pointer flex items-center gap-1"
          >
            <Minimize className="w-4 h-4" />
            <span className="text-xs font-semibold">Exit Fullscreen</span>
          </button>
        </div>
      </div>

      {/* Main Slideshow Stage */}
      <div className="flex-1 w-full relative flex items-center justify-center bg-zinc-950">
        <AnimatePresence mode="wait">
          {photos.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-3 z-10 p-6"
            >
              <div className="p-4 glass-card border border-white/5 rounded-3xl max-w-sm mx-auto shadow-2xl">
                <HelpCircle className="w-12 h-12 text-[#00f2ff] animate-pulse mx-auto mb-2" />
                <p className="text-lg font-bold text-white">No photos approved yet</p>
                <p className="text-xs text-slate-400 mt-1">
                  Once guests upload their snaps and they are approved by the host, they will show up here instantly in full-screen glory!
                </p>
              </div>
            </motion.div>
          ) : (
            activePhoto && (
              <motion.div
                key={activePhoto.id}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.02 }}
                transition={{ duration: 0.8 }}
                className="absolute inset-0 flex items-center justify-center"
              >
                {/* Ambient Blurred Background (Highly Premium Look) */}
                <div
                  className="absolute inset-0 scale-105 opacity-25 blur-3xl saturate-200 bg-cover bg-center pointer-events-none"
                  style={{ backgroundImage: `url(${activePhoto.url})` }}
                />

                {/* Primary High-Res Photo Container */}
                <div className="relative w-full h-full max-h-[82vh] max-w-[90vw] flex items-center justify-center z-10">
                  <img
                    src={activePhoto.url}
                    alt={`Snap by ${activePhoto.nickname}`}
                    className="max-w-full max-h-full object-contain rounded-2xl shadow-[0_0_80px_rgba(0,0,0,0.85)] border border-white/5"
                  />

                  {/* Creator Card */}
                  <div className="absolute bottom-6 left-6 bg-[#0c0c0c]/80 backdrop-blur-md border border-white/5 px-4 py-2.5 rounded-xl shadow-2xl text-left flex items-center gap-3">
                    <div className="w-8 h-8 bg-white/5 text-[#00f2ff] font-bold flex items-center justify-center rounded-lg text-sm border border-[#00f2ff]/20">
                      {activePhoto.nickname.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">Captured By</p>
                      <p className="text-sm font-bold text-white">{activePhoto.nickname}</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )
          )}
        </AnimatePresence>

        {/* Live QR Instruction overlay (Top Right Corner) */}
        {showQrCode && (
          <div className="absolute bottom-6 right-6 glass-card neon-border p-4 rounded-2xl shadow-2xl z-20 max-w-[210px] text-center space-y-2 animate-fade-in">
            {/* Simple Visual QR representation using local offline generation */}
            <div className="w-28 h-28 bg-white p-2 rounded-xl mx-auto flex items-center justify-center shadow-lg">
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
            <div className="space-y-0.5">
              <p className="text-xs font-extrabold text-white">Join & Share Photos</p>
              <p className="text-[10px] text-[#00f2ff] font-bold">Scan QR Code</p>
              <p className="text-[9px] text-slate-500">No downloads &bull; Free upload</p>
            </div>
          </div>
        )}
      </div>

      {/* Slide Controls - Bottom */}
      {photos.length > 0 && (
        <div className="p-6 bg-gradient-to-t from-black/95 to-transparent flex justify-center items-center gap-8 z-20">
          <button
            onClick={handlePrev}
            className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-slate-300 rounded-xl transition-all duration-300 cursor-pointer"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="p-4 bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 rounded-2xl shadow-lg shadow-[#00f2ff]/10 cursor-pointer transition-all duration-300"
          >
            {isPlaying ? <Pause className="w-5 h-5 fill-slate-950" /> : <Play className="w-5 h-5 fill-slate-950" />}
          </button>

          <button
            onClick={handleNext}
            className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-slate-300 rounded-xl transition-all duration-300 cursor-pointer"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  );
}

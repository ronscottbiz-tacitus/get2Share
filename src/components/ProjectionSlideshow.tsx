import { useEffect, useState } from 'react';
import { Play, Pause, ChevronLeft, ChevronRight, Minimize, QrCode } from 'lucide-react';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { Photo } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import QRCode from 'qrcode';
import Get2ShareLockup from './Get2ShareLockup';

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
          <Get2ShareLockup className="text-2xl" />
          <span className="font-mono text-xs font-bold tracking-[0.08em] uppercase text-g2-secondary flex items-center gap-2">
            <span className="w-2 h-2 bg-emerald-400 rounded-full" />
            Live · {photos.length} photo{photos.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Speed settings */}
          <select
            value={rotationSpeed}
            onChange={(e) => setRotationSpeed(Number(e.target.value))}
            className="bg-white/5 text-g2-secondary border border-white/10 px-3 py-1.5 rounded-xl text-xs font-medium focus:outline-none focus:border-g2-blue cursor-pointer"
          >
            <option value={4000}>Every 4s</option>
            <option value={6000}>Every 6s</option>
            <option value={10000}>Every 10s</option>
            <option value={15000}>Every 15s</option>
          </select>

          {/* Toggle instructions */}
          <button
            onClick={() => setShowQrCode(!showQrCode)}
            className={`p-2.5 rounded-xl border transition-all duration-300 cursor-pointer flex items-center gap-1.5 text-xs font-bold ${
              showQrCode
                ? 'bg-g2-blue text-white border-g2-blue shadow-md shadow-g2-blue/20'
                : 'bg-white/5 border border-white/10 text-g2-tertiary hover:text-g2-text'
            }`}
          >
            <QrCode className="w-4 h-4" />
            Join QR
          </button>

          {/* Close/Minimize */}
          <button
            onClick={onClose}
            className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-g2-secondary transition-all duration-300 cursor-pointer flex items-center gap-1"
          >
            <Minimize className="w-4 h-4" />
            <span className="text-xs font-semibold">Exit</span>
          </button>
        </div>
      </div>

      {/* Main Slideshow Stage */}
      <div className="flex-1 w-full relative flex items-center justify-center bg-g2-page">
        <AnimatePresence mode="wait">
          {photos.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-center space-y-3 z-10 p-6"
            >
              <div className="max-w-2xl mx-auto">
                <h2 aria-label="You get to be in the picture." className="font-expanded font-black text-5xl leading-[1.05] text-white">
                  <span aria-hidden="true">You <span className="text-g2-blue">Get2</span> be in the picture.</span>
                </h2>
                <p className="mt-5 text-lg text-g2-secondary">
                  Scan the code to join. Photos show up here as soon as they're posted.
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
                    alt={`Photo by ${activePhoto.nickname}`}
                    className="max-w-full max-h-full object-contain rounded-2xl shadow-[0_0_80px_rgba(0,0,0,0.85)] border border-white/5"
                  />

                  {/* Creator Card */}
                  <div className="absolute bottom-6 left-6 bg-g2-panel/80 backdrop-blur-md border border-white/5 px-4 py-2.5 rounded-xl shadow-2xl text-left flex items-center gap-3">
                    <div className="w-8 h-8 bg-white/5 text-g2-blue-light font-bold flex items-center justify-center rounded-lg text-sm border border-g2-blue/20">
                      {activePhoto.nickname.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-condensed font-extrabold text-[11px] tracking-[0.12em] uppercase text-g2-tertiary">Taken by</p>
                      <p className="text-sm font-bold text-white">{activePhoto.nickname.replace(/\s*\((Tripod|Photo Spot|Share Spot|Guest Lens|Group Shot)\)$/, '')}</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )
          )}
        </AnimatePresence>

        {/* Live QR Instruction overlay (Top Right Corner) */}
        {showQrCode && (
          <div className="absolute bottom-6 right-6 bg-g2-panel border border-white/10 p-4 rounded-xl shadow-2xl z-20 max-w-[220px] text-center space-y-2">
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
              <p className="text-sm font-extrabold text-white">Scan to join</p>
              <p className="font-mono text-[11px] text-g2-secondary">{window.location.host}</p>
              <p className="text-[11px] text-g2-tertiary">No app. Just a nickname.</p>
            </div>
          </div>
        )}
      </div>

      {/* Slide Controls - Bottom */}
      {photos.length > 0 && (
        <div className="p-6 bg-gradient-to-t from-black/95 to-transparent flex justify-center items-center gap-8 z-20">
          <button
            onClick={handlePrev}
            className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-g2-secondary rounded-xl transition-all duration-300 cursor-pointer"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="p-4 bg-g2-blue hover:bg-g2-blue-hover text-white rounded-2xl shadow-lg shadow-g2-blue/10 cursor-pointer transition-all duration-300"
          >
            {isPlaying ? <Pause className="w-5 h-5 fill-white" /> : <Play className="w-5 h-5 fill-white" />}
          </button>

          <button
            onClick={handleNext}
            className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-g2-secondary rounded-xl transition-all duration-300 cursor-pointer"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  );
}

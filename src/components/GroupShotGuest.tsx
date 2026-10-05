import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Camera, RefreshCw, Users } from 'lucide-react';
import { addDoc } from 'firebase/firestore';
import { useEvent } from '../EventContext';
import { eventPhase, expiryOf, paths } from '../events';
import { compressPhoto, uploadPhotoAsset } from '../firebase';
import { GROUP_SHOT_SUFFIX, groupShotClock } from '../groupShot';
import { useBackToClose } from '../useBackToClose';
import CloseButton from './CloseButton';

type Step = 'ask' | 'camera' | 'saving' | 'posted' | 'failed' | 'missed';

/**
 * A guest's side of a Group Shot. When the host starts one, every guest gets
 * "Group Shot in 15". Guests who tap "I'm in" open their camera, and every
 * camera fires at the same moment. Phones only open a camera after a tap, so
 * this is opt-in by design.
 */
export default function GroupShotGuest({ sessionId, nickname }: { sessionId: string; nickname: string }) {
  const { event } = useEvent();
  const gs = event.groupShot ?? null;
  const [now, setNow] = useState(() => Date.now());
  const [handled, setHandled] = useState<string | null>(null); // the Group Shot id this guest answered or dismissed
  const [step, setStep] = useState<Step>('ask');
  const [error, setError] = useState('');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const firedRef = useRef<string | null>(null);
  const [streamTick, setStreamTick] = useState(0);

  const clock = groupShotClock(gs, now);
  const live = clock !== null && gs !== null && (eventPhase(event, now) === 'live' || eventPhase(event, now) === 'wrapup');
  const asking = live && step === 'ask' && clock! < 0 && handled !== gs!.id;
  const result = step === 'missed' || step === 'posted' || step === 'failed';
  const showCamera = step === 'camera' || step === 'saving';

  // Tick while a Group Shot is on.
  useEffect(() => {
    if (!gs) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [gs?.id]);

  // A new Group Shot starts fresh.
  useEffect(() => {
    if (!gs) return;
    setStep('ask');
    setError('');
    firedRef.current = null;
  }, [gs?.id]);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => stopCamera, []);

  const startCamera = async (mode: 'environment' | 'user') => {
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setStreamTick((n) => n + 1);
      return true;
    } catch (err) {
      console.error('Group Shot camera failed:', err);
      setError("Your camera didn't open. Check that this site is allowed to use it.");
      setStep('failed');
      return false;
    }
  };

  const join = async () => {
    if (!gs) return;
    setHandled(gs.id);
    setStep('camera');
    await startCamera(facing);
  };

  const dismiss = () => {
    if (gs) setHandled(gs.id);
    stopCamera();
    setStep('ask');
  };
  useBackToClose(showCamera, dismiss);

  const flip = async () => {
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    await startCamera(next);
  };

  // The video element mounts after the camera step starts, so attach the stream here.
  useEffect(() => {
    const v = videoRef.current;
    if (!showCamera || !v || !streamRef.current || v.srcObject === streamRef.current) return;
    v.srcObject = streamRef.current;
    v.play().catch(() => {});
  }, [showCamera, streamTick]);

  // Fire at the shared moment.
  useEffect(() => {
    if (!gs || step !== 'camera' || clock === null || clock < 0 || firedRef.current === gs.id) return;
    firedRef.current = gs.id;
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setError("The camera wasn't ready in time.");
      setStep('failed');
      stopCamera();
      return;
    }
    // Keep the camera's own shape (portrait or landscape), at most 1600px on the long side.
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) { setStep('failed'); stopCamera(); return; }
    if (facing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    setStep('saving');
    stopCamera();
    canvas.toBlob(async (blob) => {
      try {
        if (!blob) throw new Error('No picture');
        const file = new File([blob], `group_${gs.id}.jpg`, { type: 'image/jpeg' });
        const compressed = await compressPhoto(file);
        const url = await uploadPhotoAsset(compressed, `group_${gs.id}_${Date.now()}.jpg`, event.id);
        await addDoc(paths.photos(event.id), {
          url,
          nickname: `${(nickname || 'Guest').slice(0, 64 - GROUP_SHOT_SUFFIX.length)}${GROUP_SHOT_SUFFIX}`,
          sessionId,
          createdAt: Date.now(),
          status: 'approved',
          reactions: { likes: 0, dislikes: 0 },
          flagged: false,
          ...expiryOf(event),
        });
        setStep('posted');
      } catch (err) {
        console.error('Group Shot upload failed:', err);
        setError("Your Group Shot didn't post. Check the Wi-Fi.");
        setStep('failed');
      }
    }, 'image/jpeg', 0.92);
  }, [clock, step, gs?.id]);

  // Too late to get the camera open.
  useEffect(() => {
    if (live && step === 'ask' && clock! >= 0 && gs && handled !== gs.id) setStep('missed');
  }, [clock, step]);

  // Clear the result a few seconds after the shot.
  useEffect(() => {
    if (step !== 'posted' && step !== 'failed' && step !== 'missed') return;
    const t = setTimeout(() => { if (gs) setHandled(gs.id); setStep('ask'); }, 3500);
    return () => clearTimeout(t);
  }, [step]);

  const secondsLeft = clock === null ? 0 : Math.max(0, Math.ceil(-clock / 1000));

  return (
    <>
      {/* "Group Shot in 15": the invitation */}
      <AnimatePresence>
        {(asking || result) && (
          <motion.div
            key="gs-ask"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            className="fixed inset-x-0 bottom-0 z-50 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] font-sans"
            role="dialog"
            aria-label="Group Shot"
          >
            <div className="max-w-md mx-auto rounded-2xl bg-g2-blue text-white p-5 shadow-[0_10px_60px_rgba(0,82,255,0.5)]">
              {step === 'ask' && (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-[11px] font-bold tracking-[0.12em] uppercase text-white/75 flex items-center gap-1.5">
                        <Users className="w-3.5 h-3.5" aria-hidden="true" /> Group Shot
                      </p>
                      <p className="mt-1 font-expanded font-black text-[26px] leading-tight">
                        Every camera fires in {secondsLeft}.
                      </p>
                      <p className="mt-1 text-sm text-white/85">Point your phone at the crowd. Everyone's photo lands in the gallery.</p>
                    </div>
                    <CloseButton onClick={dismiss} label="Not this time" size="sm" />
                  </div>
                  <button
                    type="button"
                    onClick={join}
                    className="mt-4 w-full h-14 rounded-xl bg-white text-g2-blue font-bold text-[16px] flex items-center justify-center gap-2 cursor-pointer active:scale-[0.98] transition-transform"
                  >
                    <Camera className="w-5 h-5" aria-hidden="true" /> I'm in. Open my camera
                  </button>
                </>
              )}
              {step === 'missed' && <p className="font-bold text-[16px]">Missed this one. Catch the next Group Shot!</p>}
              {step === 'posted' && <p className="font-bold text-[16px]">Got it! Your Group Shot is in the gallery.</p>}
              {step === 'failed' && <p className="font-bold text-[16px]">{error || "That one didn't work."}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The camera, counting down to the shared moment */}
      {showCamera && (
        <div className="fixed inset-0 z-[60] bg-black font-sans" role="dialog" aria-label="Group Shot camera">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className={`absolute inset-0 w-full h-full object-cover ${facing === 'user' ? '-scale-x-100' : ''}`}
          />
          <div className="absolute inset-x-0 top-0 p-4 pt-[max(1rem,env(safe-area-inset-top))] flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent">
            <p className="font-mono text-[11px] font-bold tracking-[0.12em] uppercase text-white">Group Shot</p>
            <div className="flex items-center gap-2">
              {step === 'camera' && (
                <button type="button" onClick={flip} aria-label="Flip camera" className="w-11 h-11 rounded-full bg-white/10 border border-white/20 text-white flex items-center justify-center cursor-pointer">
                  <RefreshCw className="w-5 h-5" aria-hidden="true" />
                </button>
              )}
              <CloseButton onClick={dismiss} label="Leave the Group Shot" />
            </div>
          </div>
          {step === 'camera' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" aria-live="assertive">
              <p className="font-condensed font-extrabold text-lg tracking-[0.18em] uppercase text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
                Hold still…
              </p>
              <AnimatePresence mode="popLayout">
                <motion.span
                  key={secondsLeft}
                  initial={{ scale: 1.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  className="font-expanded font-black text-[140px] leading-none text-white drop-shadow-[0_4px_20px_rgba(0,0,0,0.7)]"
                >
                  {secondsLeft}
                </motion.span>
              </AnimatePresence>
            </div>
          )}
          {step === 'saving' && (
            <motion.div initial={{ opacity: 1 }} animate={{ opacity: 0.9 }} className="absolute inset-0 bg-white flex items-center justify-center">
              <p className="font-expanded font-black text-4xl text-g2-page">Got it!</p>
            </motion.div>
          )}
        </div>
      )}
    </>
  );
}

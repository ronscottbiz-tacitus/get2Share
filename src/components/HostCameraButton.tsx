import React, { useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { addDoc } from 'firebase/firestore';
import { useEvent } from '../EventContext';
import { eventPhase, expiryOf, paths } from '../events';
import { compressPhoto, uploadPhotoAsset } from '../firebase';

interface HostCameraButtonProps {
  hostUid: string;
  /** "bar" sits in the console header; "floating" is the round shutter on phones. */
  variant?: 'bar' | 'floating';
}

/** The host takes a photo with their own phone. Host photos go straight into the gallery. */
export default function HostCameraButton({ hostUid, variant = 'bar' }: HostCameraButtonProps) {
  const { event } = useEvent();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'posted' | 'failed'>('idle');
  const phase = eventPhase(event);
  const open = phase === 'live' || phase === 'wrapup';

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setStatus('uploading');
    try {
      const blob = await compressPhoto(file);
      const url = await uploadPhotoAsset(blob, file.name || `host_${Date.now()}.jpg`, event.id);
      await addDoc(paths.photos(event.id), {
        url,
        nickname: 'Host',
        sessionId: hostUid,
        createdAt: Date.now(),
        status: 'approved',
        reactions: { likes: 0, dislikes: 0 },
        flagged: false,
        ...expiryOf(event),
      });
      setStatus('posted');
    } catch (err) {
      console.error('Host photo failed:', err);
      setStatus('failed');
    }
    setTimeout(() => setStatus('idle'), 2500);
  };

  if (!open) return null;

  const label = status === 'uploading' ? 'Posting…' : status === 'posted' ? 'Posted!' : status === 'failed' ? "Didn't post. Try again" : 'Take a photo';

  return (
    <>
      {variant === 'bar' ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={status === 'uploading'}
          className="bg-white hover:bg-white/90 disabled:opacity-60 text-g2-page font-bold px-4 py-2.5 rounded-xl text-xs flex items-center gap-1.5 cursor-pointer transition-all duration-300"
        >
          <Camera className="w-4 h-4" aria-hidden="true" /> {label}
        </button>
      ) : (
        <div className="fixed bottom-5 right-5 z-40 md:hidden flex flex-col items-center gap-1.5">
          {status !== 'idle' && (
            <span className="px-2.5 py-1 rounded-full bg-g2-page/90 border border-white/15 text-[11px] font-bold text-white" role="status">
              {label}
            </span>
          )}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={status === 'uploading'}
            aria-label="Take a photo"
            className="w-16 h-16 rounded-full border-[3px] border-white p-1 bg-g2-page/60 shadow-xl active:scale-95 transition-transform disabled:opacity-60 cursor-pointer"
          >
            <span className="flex w-full h-full rounded-full bg-white items-center justify-center text-g2-page">
              <Camera className="w-6 h-6" aria-hidden="true" />
            </span>
          </button>
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*" capture="environment" onChange={onFile} className="hidden" />
    </>
  );
}

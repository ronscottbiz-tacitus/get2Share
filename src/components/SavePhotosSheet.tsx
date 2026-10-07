import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Download, Check } from 'lucide-react';
import { useEvent } from '../EventContext';
import { Photo } from '../types';
import CloseButton from './CloseButton';
import { useBackToClose } from '../useBackToClose';
import { SHARE_BATCH, canShareFiles, downloadBlob, photoFile, shareFiles, zipFiles } from '../savePhotos';

interface SavePhotosSheetProps {
  key?: string; // no @types/react here, so JSX needs this spelled out
  photos: Photo[];
  /** What these are, for the heading: "your photos", "the whole album"… */
  what: string;
  onClose: () => void;
}

/**
 * Save several photos to this device. It gets every photo ready first (the
 * share sheet must open straight from a tap, with no waiting in between), then
 * offers one button per batch on phones, or one .zip on a laptop.
 */
export default function SavePhotosSheet({ photos, what, onClose }: SavePhotosSheetProps) {
  const { event } = useEvent();
  const [files, setFiles] = useState<File[]>([]);
  const [failed, setFailed] = useState(0);
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const started = useRef(false);
  useBackToClose(true, onClose);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const got: File[] = [];
      let bad = 0;
      // A few at a time: quick on good Wi-Fi, gentle on a busy one.
      for (let i = 0; i < photos.length; i += 4) {
        const part = await Promise.all(
          photos.slice(i, i + 4).map((p, j) => photoFile(event.name, p, i + j + 1).catch(() => null))
        );
        part.forEach((f) => (f ? got.push(f) : bad++));
        setFiles([...got]);
        setFailed(bad);
      }
      setReady(true);
    })();
  }, []);

  const phone = ready && files.length > 0 && canShareFiles(files.slice(0, 1));
  const batches: File[][] = [];
  for (let i = 0; i < files.length; i += SHARE_BATCH) batches.push(files.slice(i, i + SHARE_BATCH));

  const share = async (i: number) => {
    setError('');
    try {
      if (await shareFiles(batches[i])) setDone((d) => new Set(d).add(i));
    } catch (e) {
      console.error('Share failed:', e);
      setError("Your phone didn't open the save sheet. Try again.");
    }
  };
  const zip = async () => {
    setError('');
    try {
      if (files.length === 1) downloadBlob(files[0], files[0].name);
      else downloadBlob(await zipFiles(files), files[0].name.replace(/-\d{8}-\d{4}-1\.jpg$/, '.zip'));
      setDone(new Set([0]));
    } catch (e) {
      console.error('Download failed:', e);
      setError("Couldn't make the download. Try again.");
    }
  };

  const count = photos.length;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] bg-g2-page/75 flex items-end justify-center font-sans"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <motion.section
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-title"
        initial={{ y: 40 }}
        animate={{ y: 0 }}
        exit={{ y: 40 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[85dvh] overflow-y-auto bg-g2-panel border-t border-white/10 rounded-t-[20px] px-5 pt-3 pb-7 flex flex-col gap-4"
      >
        <div className="w-10 h-1 rounded-full bg-white/15 self-center" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">Save to this device</p>
            <h2 id="save-title" className="mt-0.5 font-expanded font-black text-[22px] leading-tight text-white">
              {count} {count === 1 ? 'photo' : 'photos'}: {what}
            </h2>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {!ready ? (
          <div className="flex flex-col gap-2" aria-live="polite">
            <p className="text-sm text-g2-secondary">Getting them ready… {files.length + failed} of {count}</p>
            <div className="h-2 rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
              <div className="h-full bg-g2-blue transition-[width] duration-300" style={{ width: `${((files.length + failed) / Math.max(1, count)) * 100}%` }} />
            </div>
          </div>
        ) : files.length === 0 ? (
          <p className="text-sm leading-relaxed text-g2-secondary">
            Couldn't get these photos on this connection. Try again in a moment, or open a photo and press and hold it to save it.
          </p>
        ) : phone ? (
          <>
            <p className="text-sm leading-relaxed text-g2-secondary">
              Tap {batches.length > 1 ? 'each button' : 'the button'}, then choose <b className="text-white">Save Image</b> (or Save to Photos).
              {batches.length > 1 ? ` Your phone takes up to ${SHARE_BATCH} at a time.` : ''}
            </p>
            <div className="flex flex-col gap-2">
              {batches.map((b, i) => {
                const from = i * SHARE_BATCH + 1;
                const to = from + b.length - 1;
                const label = batches.length === 1 ? `Save ${b.length === 1 ? 'it' : `all ${b.length}`}` : `Save photos ${from}–${to}`;
                return (
                  <button
                    key={i}
                    onClick={() => share(i)}
                    className={`h-[52px] rounded-lg font-bold text-[15px] flex items-center justify-center gap-2 cursor-pointer transition-colors ${
                      done.has(i) ? 'border border-emerald-400/40 text-emerald-200' : 'bg-g2-blue hover:bg-g2-blue-hover text-white'
                    }`}
                  >
                    {done.has(i) ? <Check className="w-5 h-5" aria-hidden="true" /> : <Download className="w-5 h-5" aria-hidden="true" />}
                    {done.has(i) ? `${label}: done` : label}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-g2-secondary">
              {files.length === 1 ? 'Downloads as a photo.' : `Downloads as one .zip file with all ${files.length}.`}
            </p>
            <button
              onClick={zip}
              className={`h-[52px] rounded-lg font-bold text-[15px] flex items-center justify-center gap-2 cursor-pointer transition-colors ${
                done.size ? 'border border-emerald-400/40 text-emerald-200' : 'bg-g2-blue hover:bg-g2-blue-hover text-white'
              }`}
            >
              {done.size ? <Check className="w-5 h-5" aria-hidden="true" /> : <Download className="w-5 h-5" aria-hidden="true" />}
              {done.size ? 'Downloaded' : files.length === 1 ? 'Download' : `Download all ${files.length}`}
            </button>
          </>
        )}

        {ready && failed > 0 && files.length > 0 && (
          <p className="text-xs text-amber-200">{failed} {failed === 1 ? 'photo' : 'photos'} couldn't be fetched. Try again later for those.</p>
        )}
        {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
      </motion.section>
    </motion.div>
  );
}

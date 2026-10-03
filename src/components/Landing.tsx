import React, { useState } from 'react';
import { ArrowRight, Camera, ScanFace, Timer } from 'lucide-react';
import { motion } from 'motion/react';
import Get2ShareLockup from './Get2ShareLockup';
import { LastEvent, normalizeJoinCode } from '../events';

interface LandingProps {
  lastEvent: LastEvent | null;
  notFoundCode?: string;
  onJoinCode: (code: string) => void;
  onHost: () => void;
}

const PROMISES = [
  { icon: ScanFace, title: 'Step into the shot', body: 'Tap the screen. Everyone gets the photo.' },
  { icon: Timer, title: 'Group Shot moments', body: 'Every camera in the room fires at once.' },
];

/** share.get2.one with no event: join one by code, or host your own. */
export default function Landing({ lastEvent, notFoundCode, onJoinCode, onHost }: LandingProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState(
    notFoundCode ? `No event uses the code ${notFoundCode}. Check it with the host; it may have been changed.` : ''
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = normalizeJoinCode(code);
    if (c.length !== 6) {
      setError('Event codes are 6 letters and numbers, like GALA26.');
      return;
    }
    onJoinCode(c);
  };

  return (
    <div className="min-h-dvh bg-g2-page text-g2-text flex flex-col px-5 pt-4 pb-5 font-sans">
      <div className="w-full max-w-md mx-auto flex flex-col flex-1">
        <header className="flex justify-between items-center h-12">
          <Get2ShareLockup className="text-[22px]" />
          <button
            onClick={onHost}
            className="h-11 px-4 rounded-full border border-white/10 text-g2-secondary hover:text-white hover:border-white/25 font-mono text-[10.5px] font-bold tracking-[0.08em] uppercase transition-colors cursor-pointer"
          >
            Sign in
          </button>
        </header>

        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mt-6"
        >
          <h1
            aria-label="Finally, you get to be in the picture. And get one too."
            className="font-expanded font-black text-[length:min(34px,calc((100vw_-_44px)/10.2))] leading-[1.04] tracking-[-0.02em] text-white"
          >
            <span aria-hidden="true" className="block">Finally,</span>
            <span aria-hidden="true" className="block">
              you <span className="text-g2-blue">Get2</span> be
            </span>
            <span aria-hidden="true" className="block">in the picture.</span>
            <span aria-hidden="true" className="block">And get one too.</span>
          </h1>
          <p className="mt-3.5 text-[15px] leading-relaxed text-g2-secondary">
            Every photo from the party, on everyone's phone. No app to download.
          </p>
        </motion.section>

        <ul className="mt-5 flex flex-col gap-3.5">
          {PROMISES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3 items-start">
              <span className="w-9 h-9 shrink-0 rounded-[10px] bg-g2-panel border border-white/[0.08] flex items-center justify-center text-g2-blue-light">
                <Icon className="w-[18px] h-[18px]" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-bold text-white">{title}</p>
                <p className="text-[13px] leading-normal text-g2-tertiary">{body}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="flex-1 min-h-6" />

        {lastEvent && (
          <button
            onClick={() => onJoinCode(lastEvent.code)}
            className="mb-3 h-[56px] px-4 rounded-xl bg-g2-panel border border-g2-blue/50 hover:border-g2-blue text-left flex items-center justify-between gap-3 cursor-pointer transition-colors"
          >
            <span className="min-w-0">
              <span className="block font-mono text-[10px] font-bold tracking-[0.08em] uppercase text-g2-blue-light">Back to</span>
              <span className="block text-[15px] font-bold text-white truncate">{lastEvent.name}</span>
            </span>
            <ArrowRight className="w-5 h-5 text-g2-blue-light shrink-0" aria-hidden="true" />
          </button>
        )}

        <form onSubmit={submit} className="bg-g2-panel border border-white/[0.08] rounded-xl p-4 flex flex-col gap-2.5">
          <label
            htmlFor="event-code"
            className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary"
          >
            At an event? Enter its code
          </label>
          <div className="flex gap-2">
            <input
              id="event-code"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. GALA26"
              value={code}
              onChange={(e) => {
                setCode(normalizeJoinCode(e.target.value));
                setError('');
              }}
              className="flex-1 min-w-0 h-[52px] px-4 bg-g2-page border border-white/10 focus:border-g2-blue rounded-lg text-white placeholder-g2-muted font-mono text-lg tracking-[0.12em] uppercase focus:outline-none transition-colors"
            />
            <button
              type="submit"
              className="h-[52px] px-5 bg-g2-blue hover:bg-g2-blue-hover text-white font-bold text-[15px] rounded-lg cursor-pointer transition-colors"
            >
              Join
            </button>
          </div>
          {error ? (
            <p className="text-red-400 text-xs" role="alert">{error}</p>
          ) : (
            <p className="text-xs text-g2-tertiary">Or scan the QR code on the screen at the party.</p>
          )}
        </form>

        <button
          onClick={onHost}
          className="mt-3 h-[52px] rounded-lg border border-white/15 hover:border-white/30 text-white font-bold text-[15px] flex items-center justify-center gap-2 cursor-pointer transition-colors"
        >
          <Camera className="w-[18px] h-[18px]" aria-hidden="true" />
          Host your own event
        </button>

        <p className="mt-4 text-center font-mono text-[10px] tracking-[0.08em] uppercase text-g2-muted">
          A Get2 product · share.get2.one
        </p>
      </div>
    </div>
  );
}

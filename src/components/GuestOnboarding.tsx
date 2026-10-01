import React, { useEffect, useState } from 'react';
import { Camera, LayoutGrid, ScanFace, Timer } from 'lucide-react';
import { motion } from 'motion/react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import Get2ShareLockup from './Get2ShareLockup';

interface OnboardingProps {
  onJoin: (nickname: string) => void;
  onGoToHost: () => void;
}

const PROMISES = [
  {
    icon: LayoutGrid,
    title: 'Every photo, all night',
    body: "Everyone's shots, in one live gallery.",
  },
  {
    icon: ScanFace,
    title: 'Step into the shot',
    body: 'Walk up to a Share Spot, frame it on your phone, tap.',
  },
  {
    icon: Timer,
    title: 'Group Shot moments',
    body: 'The countdown hits the big screen. Every camera fires at once.',
  },
];

export default function GuestOnboarding({ onJoin, onGoToHost }: OnboardingProps) {
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [eventTitle, setEventTitle] = useState('');

  // The host sets the event name in the Host Console; show it here.
  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'settings', 'event-settings'),
      (snap) => setEventTitle(snap.exists() ? snap.data().eventTitle || '' : ''),
      () => setEventTitle('')
    );
    return () => unsubscribe();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) {
      setError('Enter a nickname to join.');
      return;
    }
    onJoin(nickname.trim());
  };

  return (
    <div className="min-h-dvh bg-g2-page text-g2-text flex flex-col px-5 pt-4 pb-5 font-sans">
      <div className="w-full max-w-md mx-auto flex flex-col flex-1">
        <header className="flex justify-between items-center h-12">
          <Get2ShareLockup className="text-[22px]" />
          <button
            onClick={onGoToHost}
            className="h-11 px-4 rounded-full border border-white/10 text-g2-secondary hover:text-white hover:border-white/25 font-mono text-[10.5px] font-bold tracking-[0.08em] uppercase transition-colors cursor-pointer"
          >
            Host
          </button>
        </header>

        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mt-5 flex flex-col items-start"
        >
          {eventTitle && (
            <div className="inline-flex items-center gap-2 h-[30px] px-3 rounded-full border border-white/10 bg-g2-panel font-mono text-[10.5px] font-bold tracking-[0.08em] uppercase text-g2-secondary">
              <span className="w-[7px] h-[7px] rounded-full bg-emerald-400" />
              Live now · {eventTitle}
            </div>
          )}
          <h1
            aria-label="Finally, you get to be in the picture."
            className="mt-[18px] font-expanded font-black text-[34px] leading-[1.04] tracking-[-0.02em] text-white"
          >
            <span aria-hidden="true" className="block">Finally,</span>
            <span aria-hidden="true" className="block">
              you <span className="text-g2-blue">Get2</span> be
            </span>
            <span aria-hidden="true" className="block">in the picture.</span>
          </h1>
          <p className="mt-3.5 text-[15px] leading-relaxed text-g2-secondary">
            Every photo from tonight lands in your gallery, and Share Spots let you take the shots you're actually in.
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

        <form
          onSubmit={handleSubmit}
          className="bg-g2-panel border border-white/[0.08] rounded-xl p-4 flex flex-col gap-2.5"
        >
          <label
            htmlFor="nickname"
            className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-tertiary"
          >
            Your nickname
          </label>
          <input
            id="nickname"
            type="text"
            placeholder="e.g. Maya"
            value={nickname}
            onChange={(e) => {
              setNickname(e.target.value);
              setError('');
            }}
            maxLength={20}
            autoComplete="off"
            className="h-[52px] px-4 bg-g2-page border border-white/10 focus:border-g2-blue rounded-lg text-g2-text placeholder-g2-muted text-base focus:outline-none transition-colors"
          />
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <button
            type="submit"
            className="h-[52px] bg-g2-blue hover:bg-g2-blue-hover text-white font-bold text-[15px] rounded-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-all cursor-pointer"
          >
            <Camera className="w-[18px] h-[18px]" aria-hidden="true" />
            Join the event
          </button>
          <p className="text-center text-xs text-g2-tertiary">No app. No sign-up. Just a nickname.</p>
        </form>


        <p className="mt-4 text-center font-mono text-[10px] tracking-[0.08em] uppercase text-g2-muted">
          A Get2 product · share.get2.one
        </p>
      </div>
    </div>
  );
}

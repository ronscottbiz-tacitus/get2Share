import React, { useState } from 'react';
import { Camera, Shield, Zap, Sparkles } from 'lucide-react';
import { motion } from 'motion/react';

interface OnboardingProps {
  onJoin: (nickname: string) => void;
  onGoToHost: () => void;
  onGoToTripod: () => void;
}

export default function GuestOnboarding({ onJoin, onGoToHost, onGoToTripod }: OnboardingProps) {
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) {
      setError('Please enter a nickname to join the event');
      return;
    }
    onJoin(nickname.trim());
  };

  return (
    <div className="min-h-screen bg-[#050505] text-slate-100 flex flex-col justify-between p-6 md:p-12 relative overflow-hidden font-sans">
      {/* Background Decorative Blobs */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-[#00f2ff]/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <header className="w-full flex justify-between items-center max-w-md mx-auto">
        <div className="flex items-center gap-2">
          <div className="p-2 bg-gradient-to-tr from-[#00f2ff] to-blue-600 rounded-xl shadow-lg shadow-[#00f2ff]/10">
            <Camera className="w-6 h-6 text-slate-950" />
          </div>
          <span className="font-extrabold tracking-tight text-xl bg-gradient-to-r from-[#00f2ff] to-blue-400 bg-clip-text text-transparent">
            Get2Share
          </span>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={onGoToHost}
            className="text-xs bg-white/5 border border-white/10 hover:border-[#00f2ff]/40 text-slate-300 hover:text-[#00f2ff] px-3.5 py-2 rounded-xl transition-all duration-300 cursor-pointer backdrop-blur-sm"
          >
            Host Console
          </button>
        </div>
      </header>

      {/* Hero Body */}
      <main className="w-full max-w-md mx-auto my-auto flex flex-col items-center text-center mt-8 mb-8 z-10">
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#00f2ff]/5 border border-[#00f2ff]/20 rounded-full text-[#00f2ff] text-xs font-medium tracking-wide mb-4 shadow-[0_0_15px_rgba(0,242,255,0.05)]">
            <Sparkles className="w-3.5 h-3.5" />
            Live Event: Summer Gala 2026
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-white leading-tight mb-4">
            Capture Together,<br/>
            <span className="neon-text font-black">
              Share Live
            </span>
          </h1>
          <p className="text-slate-400 text-sm md:text-base max-w-xs mx-auto mb-8 font-light leading-relaxed">
            No heavy app downloads. Just enter a nickname, snap photos, and watch them stream live to everyone.
          </p>
        </motion.div>

        {/* Form Container */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="w-full glass-card neon-border rounded-2xl p-6 shadow-2xl"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="text-left">
              <label htmlFor="nickname" className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                Your Nickname
              </label>
              <input
                id="nickname"
                type="text"
                placeholder="e.g. Sara Miller"
                value={nickname}
                onChange={(e) => {
                  setNickname(e.target.value);
                  setError('');
                }}
                maxLength={20}
                className="w-full bg-black/60 border border-white/10 focus:border-[#00f2ff] focus:ring-1 focus:ring-[#00f2ff]/30 rounded-xl px-4 py-3.5 text-white placeholder-slate-600 focus:outline-none transition-all text-base font-medium"
                autoComplete="off"
              />
              {error && <p className="text-red-400 text-xs mt-1.5">{error}</p>}
            </div>

            <button
              type="submit"
              className="w-full bg-[#00f2ff] hover:bg-[#33f5ff] text-slate-950 font-bold py-3.5 rounded-xl shadow-lg shadow-[#00f2ff]/20 hover:shadow-[#00f2ff]/30 active:scale-[0.98] transition-all duration-300 cursor-pointer flex justify-center items-center gap-2"
            >
              <Camera className="w-5 h-5 text-slate-950" />
              Join Live Gallery
            </button>
          </form>

          {/* Quick Info Grid */}
          <div className="grid grid-cols-2 gap-4 mt-6 pt-6 border-t border-white/5 text-left text-xs text-slate-400">
            <div className="flex gap-2">
              <Shield className="w-4 h-4 text-[#00f2ff] shrink-0" />
              <div>
                <p className="font-bold text-slate-200">Privacy First</p>
                <p className="text-[10px] text-slate-500 mt-0.5">No login or password needed.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Zap className="w-4 h-4 text-[#00f2ff] shrink-0" />
              <div>
                <p className="font-bold text-slate-200">Instant Sync</p>
                <p className="text-[10px] text-slate-500 mt-0.5">Real-time live projector stream.</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Secondary Navigation */}
        <div className="mt-6 flex gap-4 text-xs text-slate-500">
          <button 
            onClick={onGoToTripod} 
            className="hover:text-[#00f2ff] hover:underline transition-colors cursor-pointer"
          >
            📸 Setup Stationary Tripod Mode
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full text-center text-[10px] text-slate-600 max-w-md mx-auto mt-auto pt-4 border-t border-white/5">
        Get2Share &bull; Designed for ultimate physical event convenience.
      </footer>
    </div>
  );
}

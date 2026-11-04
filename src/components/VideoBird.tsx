import React from 'react';

/** Flow's mascot: the Get2 bird with a video camera for a head. It flaps while `flying`, and holds
 *  still for anyone who has asked for less motion (see .video-bird in index.css). */
export default function VideoBird({ className = '', flying = false, style }: { className?: string; flying?: boolean; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 96 72" fill="none" aria-hidden="true" style={style} className={`video-bird ${flying ? 'video-bird-flying' : ''} ${className}`}>
      <g className="video-bird-body">
        {/* far wing */}
        <path className="video-bird-wing-far" d="M41 37 C39 25 33 15 24 8 C25 19 28 31 34 40 Z" fill="#0039B3" />
        {/* tail and body */}
        <path d="M4 34 L24 38 L22 46 L8 49 L14 41 Z" fill="#0052FF" />
        <path d="M18 41 C24 31 41 28 58 31 L58 49 C44 56 27 54 18 41 Z" fill="#0052FF" />
        {/* near wing */}
        <path className="video-bird-wing" d="M47 38 C43 24 33 12 18 5 C20 20 25 36 37 45 Z" fill="#5C93FF" />
        {/* camera head: a box with a lens hood, so it reads as video even when small */}
        <rect x="53" y="24" width="28" height="24" rx="5" fill="#FFFFFF" />
        <path d="M81 32 L94 25 L94 47 L81 40 Z" fill="#FFFFFF" />
        <circle cx="67" cy="36" r="7.5" fill="#050506" />
        <circle cx="67" cy="36" r="3.2" fill="#5C93FF" />
        <circle className="video-bird-rec" cx="58.5" cy="29.5" r="2.2" fill="#FF3B30" />
      </g>
    </svg>
  );
}

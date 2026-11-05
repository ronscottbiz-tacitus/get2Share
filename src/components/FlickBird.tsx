import React from 'react';

/** Flick's mascot: the Get2 bird carrying a borrowed camera. Same family and motion as VideoBird. */
export default function FlickBird({ className = '', flying = false, style }: { className?: string; flying?: boolean; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 96 76" fill="none" aria-hidden="true" style={style} className={`video-bird ${flying ? 'video-bird-flying' : ''} ${className}`}>
      <g className="video-bird-body">
        <path className="video-bird-wing-far" d="M41 31 C39 20 33 11 24 5 C25 15 28 26 34 34 Z" fill="#0039B3" />
        <path d="M6 25 L25 31 L23 38 L9 40 L15 33 Z" fill="#0052FF" />
        <path d="M19 33 C26 23 45 21 59 26 L62 34 C50 46 29 46 19 33 Z" fill="#0052FF" />
        <circle cx="64" cy="24" r="10" fill="#0052FF" />
        <path d="M73 20 L90 25 L73 29 Z" fill="#FFFFFF" />
        <circle cx="66" cy="22" r="2.4" fill="#FFFFFF" />
        <path className="video-bird-wing" d="M47 32 C43 20 33 9 18 3 C20 16 25 30 37 39 Z" fill="#5C93FF" />
        {/* the borrowed camera, held in its feet */}
        <g className="flick-bird-camera">
          <path d="M38 42 L39 51 M52 42 L51 51" stroke="#5C93FF" strokeWidth="3" strokeLinecap="round" />
          <path d="M26 56 a4 4 0 0 1 4 -4 h7 l3 -4 h10 l3 4 h7 a4 4 0 0 1 4 4 v14 a4 4 0 0 1 -4 4 h-30 a4 4 0 0 1 -4 -4 Z" fill="#FFFFFF" />
          <circle cx="45" cy="62" r="8" fill="#050506" />
          <circle cx="45" cy="62" r="3.4" fill="#5C93FF" />
          <circle className="video-bird-rec" cx="58" cy="57" r="2.2" fill="#0052FF" />
        </g>
      </g>
    </svg>
  );
}

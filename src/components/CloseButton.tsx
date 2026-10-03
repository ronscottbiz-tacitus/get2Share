import React from 'react';
import { X } from 'lucide-react';

interface CloseButtonProps {
  onClick: () => void;
  label?: string;
  /** "md" for sheets and full-screen views, "sm" inside a card. */
  size?: 'md' | 'sm';
  className?: string;
}

/** The one close X used everywhere: a visible filled circle, 44px to tap. */
export default function CloseButton({ onClick, label = 'Close', size = 'md', className = '' }: CloseButtonProps) {
  const box = size === 'md' ? 'w-11 h-11' : 'w-9 h-9';
  const icon = size === 'md' ? 'w-5 h-5' : 'w-4 h-4';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`${box} shrink-0 rounded-full bg-white/10 hover:bg-white/20 border border-white/20 text-white flex items-center justify-center cursor-pointer transition-colors ${className}`}
    >
      <X className={icon} strokeWidth={2.5} aria-hidden="true" />
    </button>
  );
}

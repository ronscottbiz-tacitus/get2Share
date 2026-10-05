import { useEffect, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';

/** One press (only the page's own full screen counts: a Mac window in full screen
 *  still shows Chrome's tabs, so the button stays until the page goes full screen).
 *  One press (remote OK or a tap) hides the browser's bars. Browsers only allow
 *  full screen after a press, so this sits in a corner until it's used. */
export default function FullscreenButton({ className = '', autoFocus = false, label = 'Full screen' }: { className?: string; autoFocus?: boolean; label?: string }) {
  const [isFull, setIsFull] = useState(() => !!document.fullscreenElement);
  const [supported] = useState(() => !!(document.documentElement.requestFullscreen || (document.documentElement as any).webkitRequestFullscreen));
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const on = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('webkitfullscreenchange', on);
    return () => {
      document.removeEventListener('fullscreenchange', on);
      document.removeEventListener('webkitfullscreenchange', on);
    };
  }, []);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  if (isFull || !supported) return null;

  const go = () => {
    const el: any = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    try {
      const r = req?.call(el);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* not allowed here */ }
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={go}
      className={`inline-flex items-center gap-2 rounded-full bg-g2-page/80 border border-white/20 text-white font-bold backdrop-blur-md cursor-pointer focus:outline-none focus-visible:ring-4 focus-visible:ring-g2-blue ${className}`}
    >
      <Maximize2 className="w-[1.1em] h-[1.1em]" aria-hidden="true" />
      {label}
    </button>
  );
}

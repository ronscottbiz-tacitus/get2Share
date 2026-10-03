import { useEffect, useRef } from 'react';

// Sheets and full-screen overlays (a photo, Save my photos, Add a Share Spot…)
// aren't pages, so the phone's back gesture used to skip right past them and
// leave the event. While one is open we add a history step for it: swiping
// back (or the browser's back button) closes the sheet instead.

let pendingBack: ReturnType<typeof setTimeout> | null = null;
let pendingMarker: string | null = null;

export function useBackToClose(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    let marker: string;
    if (pendingBack && pendingMarker && window.history.state?.sheet === pendingMarker) {
      // Re-opened right after closing (or React re-ran the effect): keep the same step.
      clearTimeout(pendingBack);
      marker = pendingMarker;
    } else {
      marker = Math.random().toString(36).slice(2);
      window.history.pushState({ ...(window.history.state || {}), sheet: marker }, '', window.location.href);
    }
    pendingBack = null;
    pendingMarker = null;

    let popped = false;
    const onPop = () => {
      if (window.history.state?.sheet === marker) return; // moved forward onto this step again
      popped = true;
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      if (popped) return;
      // Closed with the X or a button: take back the history step we added.
      pendingMarker = marker;
      pendingBack = setTimeout(() => {
        pendingBack = null;
        pendingMarker = null;
        if (window.history.state?.sheet === marker) window.history.back();
      }, 0);
    };
  }, [open]);
}

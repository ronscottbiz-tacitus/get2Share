import { useEffect, useState } from 'react';

// Decorative videos wait until the page has loaded and settled (or the visitor starts
// using it), so they never compete with the first screen on a slow phone connection.
let ready = false;
const waiters = new Set<() => void>();

function release() {
  if (ready) return;
  ready = true;
  waiters.forEach((fn) => fn());
  waiters.clear();
}

if (typeof window !== 'undefined') {
  const onUse = () => release();
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((t) =>
    window.addEventListener(t, onUse, { once: true, passive: true })
  );
  const afterLoad = () => window.setTimeout(release, 3500);
  if (document.readyState === 'complete') afterLoad();
  else window.addEventListener('load', afterLoad, { once: true });
}

/** True once decorative media may start loading. */
export function useMediaReady() {
  const [ok, setOk] = useState(ready);
  useEffect(() => {
    if (ok) return;
    const fn = () => setOk(true);
    waiters.add(fn);
    return () => {
      waiters.delete(fn);
    };
  }, [ok]);
  return ok;
}

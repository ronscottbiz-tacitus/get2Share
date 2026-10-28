import { useEffect, useState } from 'react';

// Decorative videos wait until the visitor starts using the page (a tap, key, or scroll),
// so they never compete with the first screen on a slow phone connection. Posters show until then.
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

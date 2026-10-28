import { lazy, Suspense, useEffect, useState } from 'react';
import Landing from './components/Landing';
import { EVENT_PATH_PREFIX, HOST_PATH, readLastEvent } from './eventLinks';
import { SAMPLE_PATH } from './sample';

// share.get2.one with no event shows the landing page right away, without Firebase or
// sign-in. The full app (and Firebase) loads only once someone joins, hosts or opens the sample.
const loadApp = () => import('./App');
const App = lazy(loadApp);

export default function LandingBoot() {
  const [booted, setBooted] = useState(false);

  // Start fetching the app as soon as someone starts using the page, so joining feels instant.
  useEffect(() => {
    if (booted) return;
    const warm = () => {
      loadApp();
      off();
    };
    const off = () => {
      window.removeEventListener('pointerdown', warm);
      window.removeEventListener('keydown', warm);
      window.removeEventListener('focusin', warm);
    };
    window.addEventListener('pointerdown', warm, { passive: true });
    window.addEventListener('keydown', warm);
    window.addEventListener('focusin', warm);
    return off;
  }, [booted]);

  const open = (path: string) => {
    window.history.pushState({}, '', path);
    setBooted(true);
  };

  if (booted) {
    return (
      <Suspense fallback={<div className="min-h-screen bg-g2-page" />}>
        <App />
      </Suspense>
    );
  }

  return (
    <div className="bg-g2-page text-g2-text min-h-screen selection:bg-g2-blue selection:text-white antialiased">
      <Landing
        lastEvent={readLastEvent()}
        onJoinCode={(code) => open(`${EVENT_PATH_PREFIX}${code}`)}
        onHost={() => open(HOST_PATH)}
        onSample={() => open(SAMPLE_PATH)}
      />
    </div>
  );
}

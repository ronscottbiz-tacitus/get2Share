import {StrictMode, Suspense, lazy} from 'react';
import {createRoot} from 'react-dom/client';
import LandingBoot from './LandingBoot.tsx';
import './index.css';

// The landing page (share.get2.one with no path) renders without the app or Firebase,
// so it shows up fast on a phone. Every other route loads the full app as before.
const App = lazy(() => import('./App.tsx'));
const isLanding = (window.location.pathname.replace(/\/+$/, '') || '/') === '/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="min-h-screen bg-g2-page" />}>
      {isLanding ? <LandingBoot /> : <App />}
    </Suspense>
  </StrictMode>,
);

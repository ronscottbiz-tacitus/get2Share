import {StrictMode, Suspense, lazy} from 'react';
import {createRoot} from 'react-dom/client';
import LandingBoot from './LandingBoot.tsx';
import { isLegalPath } from './legal';
import './index.css';

// The landing page (share.get2.one with no path) renders without the app or Firebase,
// so it shows up fast on a phone. Every other route loads the full app as before.
const App = lazy(() => import('./App.tsx'));
// /terms, /privacy and /refunds are plain pages: no app, no Firebase.
const LegalPage = lazy(() => import('./components/LegalPage.tsx'));
const isLanding = (window.location.pathname.replace(/\/+$/, '') || '/') === '/';
const isLegal = isLegalPath(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="min-h-screen bg-g2-page" />}>
      {isLanding ? <LandingBoot /> : isLegal ? <LegalPage path={window.location.pathname} /> : <App />}
    </Suspense>
  </StrictMode>,
);

import {StrictMode, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import { markJoin } from './joinTiming';
import App from './App.tsx';
import JoinTimerOverlay from './components/JoinTimerOverlay';

markJoin('opened');
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="min-h-screen bg-g2-page" />}>
      <App />
      <JoinTimerOverlay />
    </Suspense>
  </StrictMode>,
);

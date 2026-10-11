import {StrictMode, Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="min-h-screen bg-g2-page" />}>
      <App />
    </Suspense>
  </StrictMode>,
);

/** @module dashboard/main — mount the SPA, then register the offline service worker (04 §18.4) */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { startServiceWorker } from './app/register-sw.ts';
import './styles/globals.css';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
// After the first render: boot bookkeeping now, the worker registration on `load`.
startServiceWorker();

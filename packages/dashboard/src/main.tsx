/** @module dashboard/main — mount the SPA (after dropping retired `localStorage` keys) */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { dropRetiredStorage } from './lib/storage.ts';
import './styles/globals.css';

// An old build's template draft lived in localStorage and outlived every sign-out; drop it.
dropRetiredStorage();

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

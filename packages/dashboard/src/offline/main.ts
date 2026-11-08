/** @module offline/main — entry of `/offline.html` (04 §18.6): mounts the offline page with the real browser globals. Built in its own isolated build by `scripts/offline-sw-plugin.ts`. */
import './offline.css';
import { browserClock, browserTimers } from '../lib/clock.ts';
import { probeHealth } from '../lib/daemon-help/probe.ts';
import { mountOfflinePage, type OfflineNavigator } from './page.ts';

const root = document.getElementById('root') ?? document.body;
mountOfflinePage(
  {
    document,
    window,
    location: window.location,
    navigator: navigator as OfflineNavigator,
    caches: 'caches' in window ? window.caches : undefined,
    matchMedia: (query) => window.matchMedia(query),
    probe: () => probeHealth(),
    timers: browserTimers,
    clock: browserClock,
  },
  root,
);

/** @module app/register-sw — registers the offline service worker and does the boot bookkeeping the offline page relies on (04 §18.4). Silent on every failure: the dashboard behaves the same without a worker. */
import { browserClock, type Clock } from '@/lib/clock.ts';
import { LAST_SEEN_KEY, OFFLINE_RELOADS_KEY, parseLastSeen } from '@/lib/daemon-help/keys.ts';
import { removeSessionStorage, writeStorageJson } from '@/lib/storage.ts';

/** The worker script and its scope. */
export const SERVICE_WORKER_URL = '/sw.js';

/** The globals registration reads (injectable for tests). */
export interface RegisterEnv {
  /** `import.meta.env.PROD`: the dev server never serves a worker. */
  readonly production: boolean;
  readonly secure: boolean;
  readonly serviceWorker:
    | {
        register(
          url: string,
          options: { readonly scope: string; readonly updateViaCache: 'none' },
        ): Promise<unknown>;
      }
    | undefined;
}

/**
 * Registers `/sw.js` with scope `/` and `updateViaCache: 'none'` when this is a production build,
 * the browser has service workers and the context is secure. A rejection is ignored.
 */
export async function registerServiceWorker(env: RegisterEnv): Promise<boolean> {
  if (!env.production || !env.secure || env.serviceWorker === undefined) return false;
  try {
    await env.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/', updateViaCache: 'none' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot bookkeeping (04 §18.4): records the daemon version this dashboard came from in
 * `bh.daemon.lastSeen` (the offline page's "last used" line and `bunx browserhive@<v>`), and clears
 * the offline page's reload counter, since this boot reached the dashboard.
 */
export function recordBoot(doc: Document, clock: Clock = browserClock): void {
  const version = doc.querySelector('meta[name="browserhive-version"]')?.getAttribute('content');
  const lastSeen = parseLastSeen({ version, seen_at: clock() });
  if (lastSeen !== null) writeStorageJson(LAST_SEEN_KEY, lastSeen);
  removeSessionStorage(OFFLINE_RELOADS_KEY);
}

/** Called once from `main.tsx` after the first render: bookkeeping now, registration on `load`. */
export function startServiceWorker(win: Window = window): void {
  recordBoot(win.document);
  const register = (): void => {
    void registerServiceWorker({
      production: import.meta.env.PROD,
      secure: win.isSecureContext,
      serviceWorker: 'serviceWorker' in win.navigator ? win.navigator.serviceWorker : undefined,
    });
  };
  if (win.document.readyState === 'complete') register();
  else win.addEventListener('load', register, { once: true });
}

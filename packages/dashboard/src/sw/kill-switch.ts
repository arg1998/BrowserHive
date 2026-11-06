/** @module sw/kill-switch — the worker a release ships if a released `sw.js` misbehaves (04 §18.5.7):
 * it takes over at once, deletes every `bh-offline-*` cache, unregisters and claims the pages, and
 * has no `fetch` listener, so every request goes to the network as if no worker existed. Built in
 * place of `sw.ts` with `BHDEV_SW_KILL_SWITCH=1 bun run --filter @browserhive/dashboard build`.
 */
import { retire, type WorkerScope } from './scope.ts';

/** The part of the scope the kill switch uses. */
export type KillSwitchScope = Pick<
  WorkerScope,
  'caches' | 'registration' | 'clients' | 'skipWaiting' | 'addEventListener'
>;

/** Registers the kill switch's `install` and `activate` listeners, and nothing else. */
export function startKillSwitch(scope: KillSwitchScope): void {
  scope.addEventListener('install', (event) => event.waitUntil(scope.skipWaiting()));
  scope.addEventListener('activate', (event) =>
    event.waitUntil(
      (async () => {
        await retire(scope);
        await scope.clients.claim();
      })(),
    ),
  );
}

declare const SW_VERSION: string;

// Only the plugin's build defines the constants; importing this module (tests) starts nothing.
if (typeof SW_VERSION === 'string') startKillSwitch(self as unknown as KillSwitchScope);

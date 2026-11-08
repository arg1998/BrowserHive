/** @module app/register-sw.test — worker registration conditions and the boot bookkeeping (04 §18.4) */
import '../../test/setup.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { LAST_SEEN_KEY, OFFLINE_RELOADS_KEY } from '@/lib/daemon-help/keys.ts';
import { recordBoot, registerServiceWorker } from './register-sw.ts';

function fakeContainer(fail = false) {
  const calls: unknown[][] = [];
  return {
    calls,
    register: async (...args: unknown[]) => {
      calls.push(args);
      if (fail) throw new Error('SecurityError');
      return {};
    },
  };
}

afterEach(() => {
  document.head.querySelector('meta[name="browserhive-version"]')?.remove();
  localStorage.clear();
  sessionStorage.clear();
});

describe('registerServiceWorker', () => {
  it('registers /sw.js with scope / and updateViaCache none', async () => {
    const container = fakeContainer();
    expect(
      await registerServiceWorker({ production: true, secure: true, serviceWorker: container }),
    ).toBe(true);
    expect(container.calls).toEqual([['/sw.js', { scope: '/', updateViaCache: 'none' }]]);
  });

  it('does nothing in development, in an insecure context or without service workers', async () => {
    const container = fakeContainer();
    expect(
      await registerServiceWorker({ production: false, secure: true, serviceWorker: container }),
    ).toBe(false);
    expect(
      await registerServiceWorker({ production: true, secure: false, serviceWorker: container }),
    ).toBe(false);
    expect(
      await registerServiceWorker({ production: true, secure: true, serviceWorker: undefined }),
    ).toBe(false);
    expect(container.calls).toEqual([]);
  });

  it('swallows a rejected registration', async () => {
    const container = fakeContainer(true);
    expect(
      await registerServiceWorker({ production: true, secure: true, serviceWorker: container }),
    ).toBe(false);
  });
});

describe('recordBoot', () => {
  it('writes bh.daemon.lastSeen from the version meta and clears the reload counter', () => {
    const meta = document.createElement('meta');
    meta.name = 'browserhive-version';
    meta.content = '0.3.0';
    document.head.appendChild(meta);
    sessionStorage.setItem(OFFLINE_RELOADS_KEY, '[1,2]');
    recordBoot(document, () => 1_700_000_000_000);
    expect(JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? 'null')).toEqual({
      version: '0.3.0',
      seen_at: 1_700_000_000_000,
    });
    expect(sessionStorage.getItem(OFFLINE_RELOADS_KEY)).toBeNull();
  });

  it('writes nothing without a valid version meta (the Vite dev server)', () => {
    recordBoot(document, () => 1);
    expect(localStorage.getItem(LAST_SEEN_KEY)).toBeNull();
  });
});

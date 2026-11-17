/** @module infra/browsers/page-sites.test — the domains a template browser's windows opened as pages (review #85 H1, M3, M4): only top-level document requests count (an embedded frame, a subresource or a worker never does), every redirect hop counts, the set is capped with the oldest evicted, and it is kept in `page-sites.json` across restarts. */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import {
  addPageSite,
  hopsOf,
  isTopLevelNavigation,
  MAX_PAGE_SITES,
  pageSitesFileOf,
  readPageSites,
  watchPageSites,
  writePageSites,
} from './page-sites.ts';

interface FakeRequest {
  url(): string;
  isNavigationRequest(): boolean;
  frame(): { parentFrame(): unknown };
  redirectedFrom(): FakeRequest | null;
}

function request(
  url: string,
  options: { nav?: boolean; sub?: boolean; worker?: boolean; from?: FakeRequest | null } = {},
): FakeRequest {
  return {
    url: () => url,
    isNavigationRequest: () => options.nav ?? true,
    frame: () => {
      if (options.worker === true) throw new Error('Service Worker requests do not have a frame');
      return { parentFrame: () => (options.sub === true ? {} : null) };
    },
    redirectedFrom: () => options.from ?? null,
  };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bh-page-sites-'));
  dirs.push(dir);
  return join(dir, 'templates', 'tp-x', 'page-sites.json');
}

describe('top-level navigations', () => {
  it('counts a main-frame navigation; never an embedded frame, a subresource or a worker', () => {
    expect(isTopLevelNavigation(request('https://a.test/'))).toBe(true);
    expect(isTopLevelNavigation(request('https://ads.test/', { sub: true }))).toBe(false);
    expect(isTopLevelNavigation(request('https://cdn.test/x.js', { nav: false }))).toBe(false);
    expect(isTopLevelNavigation(request('https://sw.test/', { worker: true }))).toBe(false);
  });

  it('every redirect hop of a top-level request', () => {
    const first = request('https://accounts.idp.test/signin');
    const hop = request('https://accounts.youtube.test/SetSID', { from: first });
    const last = request('https://www.idp.test/home', { from: hop });
    expect(hopsOf(last)).toEqual([
      'https://www.idp.test/home',
      'https://accounts.youtube.test/SetSID',
      'https://accounts.idp.test/signin',
    ]);
  });

  it('caps the set, evicting the oldest, and refreshes a domain seen again', () => {
    const sites = new Set<string>();
    for (let i = 0; i < MAX_PAGE_SITES; i += 1) addPageSite(sites, `s${i}.test`);
    expect(addPageSite(sites, 's0.test')).toBe(false);
    expect(addPageSite(sites, 'new.test')).toBe(true);
    expect(sites.size).toBe(MAX_PAGE_SITES);
    expect(sites.has('s1.test')).toBe(false);
    expect(sites.has('s0.test')).toBe(true);
    expect(addPageSite(sites, '')).toBe(false);
  });
});

describe('watchPageSites', () => {
  it('records the context’s top-level requests and their hops, not frames, and keeps them on disk', async () => {
    const file = tempFile();
    const listeners: ((r: FakeRequest) => void)[] = [];
    const context = {
      on: (event: string, fn: (r: FakeRequest) => void) => {
        if (event === 'request') listeners.push(fn);
      },
    };
    const sites = new Set<string>();
    const watch = watchPageSites(context as never, sites, file, createCollectingLogger());
    const emit = (r: FakeRequest) => {
      for (const fn of listeners) fn(r);
    };
    emit(
      request('https://www.idp.test/done', {
        from: request('https://accounts.cookie-bounce.test/set', {
          from: request('https://login.idp.test/'),
        }),
      }),
    );
    emit(request('https://ads.tracker.test/frame', { sub: true }));
    emit(request('https://cdn.test/app.js', { nav: false }));
    // A popup's page the host adopted (its first request went by unseen).
    watch.record('https://appleid.apple.test/auth');
    expect([...sites].sort()).toEqual(['apple.test', 'cookie-bounce.test', 'idp.test']);
    await watch.flush();
    expect((await readPageSites(file)).sort()).toEqual([
      'apple.test',
      'cookie-bounce.test',
      'idp.test',
    ]);

    // A new browser process starts from the file.
    const after = new Set<string>();
    watchPageSites({ on: () => undefined } as never, after, file, createCollectingLogger());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...after].sort()).toEqual(['apple.test', 'cookie-bounce.test', 'idp.test']);
  });

  it('reads a missing or broken file as empty; writes names only', async () => {
    const file = tempFile();
    expect(await readPageSites(file)).toEqual([]);
    await writePageSites(file, ['a.test', 'b.test']);
    expect(await readPageSites(file)).toEqual(['a.test', 'b.test']);
    expect(pageSitesFileOf('/data/templates/tp-1/userdata')).toBe(
      join('/data/templates/tp-1', 'page-sites.json'),
    );
  });
});

/// <reference lib="dom" />
/** @module test/integration/site-pack-guard-shapes.test — review PR #83 M2 on real Chromium: the URL shapes servers read as the guarded path (`//m/logout`, `/m/logout;x`, `/m/logout%2F`, a trailing-dot host) and the request types a page can sign out with (`<img>`, prefetch, `<script>`, stylesheet, `EventSource`) are all blocked by a `logout` guard without `resource_types`, and none reaches the site. WebSockets are never routed (documented). */

import { afterEach, describe, expect, it } from 'bun:test';
import { type Guarded, guarded, SITE, stopGuarded, until } from './site-pack-guards-fixture.ts';
import { HEADED } from './template-fixture.ts';

afterEach(stopGuarded);

const logoutHits = (g: Guarded) => g.hits().filter((h) => h.guard_id === 'logout');
const reachedLogout = (g: Guarded) =>
  g.w.sites.requests.filter((r) => r.path.toLowerCase().includes('m/logout')).length;

async function fetchPost(g: Guarded, path: string): Promise<string> {
  return g.page.evaluate(
    (p) =>
      fetch(p, { method: 'POST' }).then(
        () => 'sent',
        () => 'blocked',
      ),
    path,
  );
}

/** A top-level load that the guard aborts, then the error page it commits. */
async function blockedLoad(g: Guarded, url: string): Promise<void> {
  await expect(g.page.goto(url)).rejects.toThrow();
  await until(() => g.page.url().startsWith('chrome-error://'));
  await g.page.goto(g.w.sites.url(SITE, '/feed'));
}

describe(`site-pack guard shapes (stealth off${HEADED ? ', headed' : ''})`, () => {
  it('blocks the path shapes a server reads as the guarded path, by fetch and by load', async () => {
    const g = await guarded();
    for (const path of [
      '//m/logout',
      '/m/logout;jsessionid=x',
      '/m/logout%2F',
      '/x/%2E%2E/m/logout',
    ]) {
      expect(await fetchPost(g, `https://${SITE}${path}`)).toBe('blocked');
    }
    await until(() => logoutHits(g).length === 4).catch(() => {
      throw new Error(`hits ${JSON.stringify(logoutHits(g).map((h) => h.url))}`);
    });
    await blockedLoad(g, `https://${SITE}//m/logout`);
    await blockedLoad(g, `https://${SITE}/m/logout;x`);
    await blockedLoad(g, `https://${SITE}/m/logout%2F`);
    await blockedLoad(g, `https://${SITE}./m/logout`);
    await until(() => logoutHits(g).length === 8).catch(() => {
      throw new Error(`hits ${JSON.stringify(logoutHits(g).map((h) => h.url))}`);
    });
    expect(reachedLogout(g)).toBe(0);
  });

  it('blocks every request type a page can sign out with (no resource_types on the guard)', async () => {
    const g = await guarded();
    await g.page.evaluate(() => {
      const img = new Image();
      img.src = '/m/logout/img';
      document.body.append(img);
      for (const [rel, as] of [
        ['prefetch', null],
        ['stylesheet', null],
        ['preload', 'fetch'],
      ] as const) {
        const link = document.createElement('link');
        link.rel = rel;
        if (as !== null) link.as = as;
        link.href = `/m/logout/${rel}`;
        document.head.append(link);
      }
      const script = document.createElement('script');
      script.src = '/m/logout/script';
      document.head.append(script);
      const source = new EventSource('/m/logout/events');
      setTimeout(() => source.close(), 2_000);
    });
    // Six requests on six paths beneath the guarded one (distinct URLs: identical hits would be
    // coalesced into one row per second, review L3).
    await until(() => logoutHits(g).length >= 6).catch(() => {
      throw new Error(`hits ${JSON.stringify(logoutHits(g).map((h) => h.url))}`);
    });
    expect(reachedLogout(g)).toBe(0);
    expect(new Set(logoutHits(g).map((h) => h.method))).toEqual(new Set(['GET']));
  });
});

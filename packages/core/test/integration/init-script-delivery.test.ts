/// <reference lib="dom" />
/**
 * @module test/integration/init-script-delivery — the D40 contract on real Chromium: BrowserHive turns
 * Patchright's client-side document route off on every context (`suppressInjectRoute`), and init
 * scripts still reach the main frame, a popup's first document and a cross-site (out-of-process)
 * iframe, while the side effects of that route are gone: loopback cross-origin requests work (Local
 * Network Access keeps the document's address space), CORS preflights reach the site, and the HTTP
 * cache is kept. Run for stealth off and on, and with tracing on (tracing also installs the route).
 * If a Patchright bump renames the flag, these fail loudly.
 *
 * Every origin here is served from loopback, so the page and its targets share one IP address
 * space and Local Network Access does not restrict them; the cross-site host names are mapped to
 * 127.0.0.1 with `--host-resolver-rules`.
 */

import { describe, expect, it } from 'bun:test';
import type { BrowserContext, Page } from 'patchright';
import { evaluateMainWorld } from '../../src/infra/browsers/evaluate.ts';
import { type FixtureServer, startFixtureServer } from '../helpers/fixture-server.ts';
import { evalMain, useDriverFixtures } from './driver-fixture.ts';

const RESOLVER = ['--host-resolver-rules=MAP *.test 127.0.0.1'];

/** Patchright's own state on a client context (not public API; pinned here on purpose). */
function routeState(context: BrowserContext): { injecting: unknown; routes: number } {
  const raw = context as unknown as { routeInjecting?: unknown; _routes?: unknown[] };
  return { injecting: raw.routeInjecting, routes: raw._routes?.length ?? -1 };
}

/** A preflighted cross-origin write (JSON body, a custom header) from `page` to `url`. */
function write(page: Page, url: string): Promise<string> {
  return page.evaluate(
    (target) =>
      fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-custom': '1' },
        body: '{}',
      }).then(
        (r) => `ok:${r.status}`,
        (e: Error) => `err:${e.name}`,
      ),
    url,
  );
}

/** A simple cross-origin GET (no preflight) from `page` to `url`. */
function simpleGet(page: Page, url: string): Promise<string> {
  return page.evaluate(
    (target) =>
      fetch(target).then(
        (r) => `ok:${r.status}`,
        (e: Error) => `err:${e.name}`,
      ),
    url,
  );
}

function methods(server: FixtureServer, prefix: string): string[] {
  return server.requests.filter((r) => r.path.startsWith(prefix)).map((r) => r.method);
}

describe('init-script delivery without Patchright document route (D40, real Chromium)', () => {
  const { state } = useDriverFixtures();

  for (const leg of [
    { stealth: false, tracing: false },
    { stealth: true, tracing: false },
    { stealth: true, tracing: true },
  ] as const) {
    const name = `${leg.stealth ? 'stealth' : 'plain'}${leg.tracing ? '-traced' : ''}`;

    it(`[${name}] no driver route; an init script reaches the main frame, a popup and a cross-site iframe`, async () => {
      const session = await state.launch({
        slug: `d40-${name}`,
        stealth: leg.stealth,
        tracing: leg.tracing,
        launchOptions: { args: RESOLVER },
      });
      const context = session.handle.context;
      expect(routeState(context)).toEqual({ injecting: true, routes: 0 });
      await context.addInitScript(() => {
        (window as unknown as { __bhMarker: number }).__bhMarker = 1;
      });
      expect(routeState(context)).toEqual({ injecting: true, routes: 0 });

      const port = new URL(state.fixture.url('/')).port;
      const frameUrl = `http://frame.test:${port}/d40/frame`;
      await session.page.goto(
        `http://page.test:${port}/d40/page?frame=${encodeURIComponent(frameUrl)}`,
      );
      const seen = () => (window as unknown as { __seenAtParse?: string }).__seenAtParse;
      expect(await evalMain(session, seen)).toBe('number');

      const frame = session.page.frames().find((f) => f.url().startsWith(frameUrl));
      if (frame === undefined) throw new Error('the cross-site frame did not load');
      expect(await evaluateMainWorld(frame, true, seen)).toBe('number');

      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        session.page.click('#popup'),
      ]);
      await popup.waitForLoadState('domcontentloaded');
      expect(await evaluateMainWorld(popup, true, seen)).toBe('number');
      await popup.close();
    });

    it(`[${name}] loopback cross-origin requests work and preflights reach the site`, async () => {
      const other = startFixtureServer();
      try {
        const session = await state.launch({
          slug: `d40-net-${name}`,
          stealth: leg.stealth,
          tracing: leg.tracing,
        });
        await session.page.goto(state.fixture.url('/'));
        // Simple and preflighted requests the site allows.
        expect(await simpleGet(session.page, other.url('/cors-allowed/read'))).toBe('ok:200');
        expect(await write(session.page, other.url('/cors-allowed/write'))).toBe('ok:200');
        expect(methods(other, '/cors-allowed/write')).toEqual(['OPTIONS', 'POST']);
        // A write the site refuses at preflight is never sent.
        expect(await write(session.page, other.url('/cors/write'))).toBe('err:TypeError');
        expect(methods(other, '/cors/')).toEqual(['OPTIONS']);
      } finally {
        other.stop();
      }
    });

    it(`[${name}] keeps the HTTP cache`, async () => {
      const session = await state.launch({
        slug: `d40-cache-${name}`,
        stealth: leg.stealth,
        tracing: leg.tracing,
      });
      await session.page.goto(state.fixture.url('/'));
      for (let i = 0; i < 2; i++) {
        await session.page.evaluate(() =>
          fetch('/cached', { cache: 'force-cache' }).then((r) => r.text()),
        );
      }
      expect(state.fixture.requests.filter((r) => r.path === '/cached')).toHaveLength(1);
    });
  }
});

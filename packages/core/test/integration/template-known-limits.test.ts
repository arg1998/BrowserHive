/// <reference lib="dom" />
/** @module test/integration/template-known-limits.test — what a template host's always-on routing changes, pinned under both drivers (spec 13 §3.8 "Known limits", `docs/guide/templates.md`; PR #76 F2): no HTTP cache and CORS preflights answered by Playwright (a refused write is sent) but not by Patchright, on every OS headless (routing does not depend on the display); a close-time beacon is unrouted and reaches the site, headless and headed. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Session } from '../../src/domain/session/session.ts';
import {
  type DriverName,
  HEADED,
  type TemplateWorld,
  templateWorld,
  until,
} from './template-fixture.ts';

const DRIVERS: readonly DriverName[] = ['playwright', 'patchright'];

function pageOf(session: Session) {
  const page = session.view?.page;
  if (page === undefined) throw new Error(`${session.id} has no page`);
  return page;
}

let world: TemplateWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

for (const driver of DRIVERS) {
  describe(`template host known limits (${driver}${HEADED ? ', headed' : ''})`, () => {
    // Routing semantics do not depend on the display: pinned on the headless legs.
    it.skipIf(HEADED)(
      'serves nothing from the HTTP cache: a reload refetches every cacheable script',
      async () => {
        world = await templateWorld(driver);
        const page = pageOf(await world.launch('alpha'));
        const sites = world.sites;
        const cached = () => sites.requests.filter((r) => r.path.startsWith('/cached.js')).length;
        await page.goto(sites.url('site-a.test', '/cache-page'));
        const first = cached();
        await page.goto(sites.url('site-a.test', '/cache-page'));
        expect(first).toBe(5);
        expect(cached() - first).toBe(5);
      },
    );

    it.skipIf(HEADED)(
      driver === 'playwright'
        ? 'a cross-origin write whose preflight the site refuses is sent (Playwright answers the preflight)'
        : 'a cross-origin write whose preflight the site refuses is not sent',
      async () => {
        world = await templateWorld(driver);
        const page = pageOf(await world.launch('alpha'));
        const sites = world.sites;
        await page.goto(sites.url('site-a.test', '/cors-page'));
        const result = await page.evaluate(() =>
          fetch('https://site-b.test/api/write', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-test': '1' },
            body: '{}',
          }).then(
            (r) => `status ${r.status}`,
            () => 'blocked',
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        const seen = sites.requests
          .filter((r) => r.host.startsWith('site-b.test') && r.path === '/api/write')
          .map((r) => r.method);
        // The page never reads the answer either way (no CORS headers).
        expect(result).toBe('blocked');
        expect(seen).toEqual(driver === 'playwright' ? ['POST'] : []);
      },
    );

    it('a beacon sent from pagehide while the page closes reaches the site unrouted', async () => {
      world = await templateWorld(driver);
      const session = await world.launch('alpha');
      const sites = world.sites;
      const tab = await world.sessions.newTab(session);
      await tab.page.goto(sites.url('site-a.test', '/unload-beacon'));
      await tab.page.close();
      await until(
        () => sites.requests.some((r) => r.path === '/api/pagehide'),
        5_000,
        'the beacon',
      );
    });
  });
}

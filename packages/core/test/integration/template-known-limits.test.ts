/// <reference lib="dom" />
/** @module test/integration/template-known-limits.test — what a template host's always-on routing changes, pinned under both drivers (spec 13 §3.8 "Known limits", `docs/guide/templates.md`; PR #76 F2): no HTTP cache; CORS preflights answered by Playwright (a refused write is sent) but not by Patchright; a close-time beacon headless versus headed. */

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
    it('serves nothing from the HTTP cache: a reload refetches every cacheable script', async () => {
      world = await templateWorld(driver);
      const page = pageOf(await world.launch('alpha'));
      const sites = world.sites;
      const cached = () => sites.requests.filter((r) => r.path.startsWith('/cached.js')).length;
      await page.goto(sites.url('site-a.test', '/cache-page'));
      const first = cached();
      await page.goto(sites.url('site-a.test', '/cache-page'));
      expect(first).toBe(5);
      expect(cached() - first).toBe(5);
    });

    it(
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

    it(
      HEADED
        ? 'a beacon sent from pagehide while the page closes does not reach the site (headed)'
        : 'a beacon sent from pagehide while the page closes reaches the site unrouted (headless)',
      async () => {
        world = await templateWorld(driver);
        const session = await world.launch('alpha');
        const sites = world.sites;
        const page = await world.sessions.newTab(session);
        await page.page.goto(sites.url('site-a.test', '/unload-beacon'));
        await page.page.close();
        const arrived = () => sites.requests.some((r) => r.path === '/api/pagehide');
        if (HEADED) {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          expect(arrived()).toBe(false);
        } else {
          await until(arrived, 5_000, 'the pagehide beacon');
        }
      },
    );
  });
}

/// <reference lib="dom" />
/** @module test/integration/template-known-limits.test — what a template host's always-on routing changes, pinned under template stealth off and standard on Patchright, the only driver (spec 13 §3.8 "Known limits", `docs/guide/templates.md`; PR #76 F2, D-65, D-66): no HTTP cache; CORS preflights stay real (D-66: Chromium sends them and honours the site's answer, so a write the site refuses at preflight is not sent; the chain's route is the only route on the host: Patchright's document route is off, D40), on every OS headless (routing does not depend on the display); a close-time beacon is never routed (whether it reaches the site depends on timing). The fixture sites resolve to loopback like the page, so Local Network Access does not restrict them. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Session } from '../../src/domain/session/session.ts';
import { PASS } from '../../src/infra/browsers/interception-chain.ts';
import { HEADED, STEALTH_LEGS, type TemplateWorld, templateWorld } from './template-fixture.ts';

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

for (const stealth of STEALTH_LEGS) {
  describe(`template host known limits (stealth ${stealth}${HEADED ? ', headed' : ''})`, () => {
    // Routing semantics do not depend on the display: pinned on the headless legs.
    it.skipIf(HEADED)(
      'serves nothing from the HTTP cache: a reload refetches every cacheable script',
      async () => {
        world = await templateWorld(stealth);
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
      "a cross-origin write is sent only when the site's own preflight answer allows it (D-66)",
      async () => {
        world = await templateWorld(stealth);
        const page = pageOf(await world.launch('alpha'));
        // The host's chain is the only route on its context (Patchright's own is off, D40), and
        // it hands preflights to Chromium.
        const raw = world.host().context as unknown as {
          routeInjecting?: unknown;
          _routes?: unknown[];
        };
        expect([raw.routeInjecting, raw._routes?.length]).toEqual([true, 1]);
        expect(world.host().chain.preflightsEnforced).toBe(true);
        const sites = world.sites;
        await page.goto(sites.url('site-a.test', '/cors-page'));
        const write = (path: string) =>
          page.evaluate(
            (url) =>
              fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-test': '1' },
                body: '{}',
              }).then(
                (r) => `status ${r.status}`,
                () => 'blocked',
              ),
            `https://site-b.test${path}`,
          );
        const seen = (path: string) =>
          sites.requests
            .filter((r) => r.host.startsWith('site-b.test') && r.path === path)
            .map((r) => r.method);
        // Refused at preflight: the write is never sent.
        expect(await write('/api/write')).toBe('blocked');
        expect(seen('/api/write')).toEqual(['OPTIONS']);
        // Allowed at preflight: sent once, and readable.
        expect(await write('/api/write-allowed')).toBe('status 200');
        expect(seen('/api/write-allowed')).toEqual(['OPTIONS', 'POST']);
      },
    );

    it('a beacon sent from pagehide while the page closes is never routed', async () => {
      world = await templateWorld(stealth);
      const session = await world.launch('alpha');
      const sites = world.sites;
      // What the host's chain sees (the request-guard slot is free until site packs).
      const routed: string[] = [];
      const added = world.host().chain.register({
        id: 'request-guard',
        onError: 'open',
        handle: async (request) => {
          routed.push(new URL(request.url()).pathname);
          return PASS;
        },
      });
      if (!added.ok) throw added.error;
      const tab = await world.sessions.newTab(session);
      await tab.page.goto(sites.url('site-a.test', '/unload-beacon'));
      expect(routed).toContain('/unload-beacon');
      // Bounded as production closes are (template-view.ts): on Windows a keepalive beacon paused in
      // the route can hold the target's destruction (one CI hang of 30 s).
      await Promise.race([
        tab.page.close({ runBeforeUnload: false }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // Whether it reaches the site depends on timing (measured both ways on CI); it is never routed,
      // so no owner and no site rule ever sees it.
      expect(routed).not.toContain('/api/pagehide');
    }, 60_000);
  });
}

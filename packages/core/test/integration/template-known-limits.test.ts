/// <reference lib="dom" />
/** @module test/integration/template-known-limits.test — what a template host's always-on routing changes, pinned under stealth off and standard on Patchright, the only driver (spec 13 §3.8 "Known limits", `docs/guide/templates.md`; PR #76 F2, D-65): no HTTP cache, on every OS headless (routing does not depend on the display); a cross-origin write that needs a CORS preflight: on a stealth-off host the driver answers the preflight itself and a write the site refuses is sent, on a stealth host (init scripts) it fails before reaching the site (Patchright's init-script interception; D-65 re-measurement); a close-time beacon is never routed (whether it reaches the site depends on timing). */

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
      stealth === 'off'
        ? 'a cross-origin write whose preflight the site refuses is sent (the driver answers the preflight)'
        : 'a cross-origin write that needs a preflight never reaches the site (init-script interception)',
      async () => {
        world = await templateWorld(stealth);
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
        expect(seen).toEqual(stealth === 'off' ? ['POST'] : []);
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

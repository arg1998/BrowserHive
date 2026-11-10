/** @module test/integration/template-self-origin.test — a template browser never reaches BrowserHive (spec 13 §3.8, PR #76 F1): every loopback spelling of the daemon is aborted by the host's route, and a redirect hop (which the route never sees) carries the marker cookie the real HTTP app refuses with 403. Both drivers. */

import { afterEach, describe, expect, it } from 'bun:test';
import { createHttpKit } from '../helpers/http-kit.ts';
import { type DriverName, type TemplateWorld, templateWorld } from './template-fixture.ts';

const DRIVERS: readonly DriverName[] = ['playwright', 'patchright'];

let world: TemplateWorld | null = null;
let stopDaemon: (() => void) | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
  stopDaemon?.();
  stopDaemon = null;
});

/** The real HTTP app on a loopback socket, recording what reaches it. */
async function startDaemon() {
  const kit = await createHttpKit({ seed: false });
  const hits: { host: string; path: string; cookie: string; status: number }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const response = await kit.http.app.fetch(req);
      const url = new URL(req.url);
      hits.push({
        host: req.headers.get('host') ?? '',
        path: url.pathname,
        cookie: req.headers.get('cookie') ?? '',
        status: response.status,
      });
      return response;
    },
  });
  stopDaemon = () => server.stop(true);
  const port = server.port ?? 0;
  const origins = ['127.0.0.1', 'localhost', '[::1]'].map((h) => `http://${h}:${port}`);
  return { port, hits, origins };
}

for (const driver of DRIVERS) {
  describe(`template self-origin guard (${driver})`, () => {
    it('aborts every loopback spelling of the daemon in the route', async () => {
      const daemon = await startDaemon();
      world = await templateWorld(driver, { selfOrigins: daemon.origins });
      const session = await world.launch('alpha');
      const page = session.view?.page;
      if (page === undefined) throw new Error('no page');
      const P = daemon.port;
      for (const url of [
        `http://localhost:${P}/control`,
        `http://foo.localhost:${P}/sub`,
        `http://LOCALHOST.:${P}/dot`,
        `http://127.0.0.2:${P}/alias`,
        `http://[::ffff:127.0.0.1]:${P}/mapped`,
        `http://[::1]:${P}/v6`,
      ]) {
        const outcome = await page.goto(url, { timeout: 10_000 }).then(
          () => 'loaded',
          (err: unknown) => String(err),
        );
        expect([url, outcome.includes('ERR_BLOCKED_BY_CLIENT')]).toEqual([url, true]);
      }
      expect(daemon.hits).toEqual([]);
    });

    it('a redirect hop the route cannot see reaches the daemon marked, and is refused with 403', async () => {
      const daemon = await startDaemon();
      world = await templateWorld(driver, { selfOrigins: daemon.origins });
      const session = await world.launch('alpha');
      const page = session.view?.page;
      if (page === undefined) throw new Error('no page');
      const to = `http://localhost:${daemon.port}/via-redirect`;
      const response = await page
        .goto(world.sites.url('site-a.test', `/redir?to=${encodeURIComponent(to)}`))
        .catch(() => null);
      expect(daemon.hits.length).toBeGreaterThan(0);
      for (const hit of daemon.hits) {
        expect(hit.cookie).toContain('browserhive_template_host=1');
        expect(hit.status).toBe(403);
      }
      if (response !== null) expect(response.status()).toBe(403);
    });
  });
}

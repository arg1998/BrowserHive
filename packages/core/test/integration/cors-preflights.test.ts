/// <reference lib="dom" />
/**
 * @module test/integration/cors-preflights — real CORS preflights in routed contexts on real Chromium
 * (D-66, deferred D41): under BrowserHive's interception chain (the blocklist route, the guard's
 * chain, the self-origin guard) Chromium sends the preflight itself and honours the site's answer,
 * as it does without a route. Run for stealth off and on (both Patchright, D-65). If a Patchright
 * bump changes the internals the preflight hook reads, these fail loudly (`hasPreflightHook`, and
 * the refused write reaching the site).
 *
 * The page and its targets are all served from loopback, so they share one IP address space and
 * Local Network Access does not restrict them: the outcome is CORS alone.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'patchright';
import { Blocklist } from '../../src/domain/policies/blocklist.ts';
import {
  compileRequestGuardRules,
  type RequestGuardRuleInput,
  RequestGuardRuleSet,
} from '../../src/domain/policies/request-guard.ts';
import { InMemoryRequestGuardHits } from '../../src/infra/audit/in-memory-guard-hits.ts';
import {
  blocklistHandler,
  installBlocklistRoute,
} from '../../src/infra/browsers/blocklist-route.ts';
import { hasPreflightHook } from '../../src/infra/browsers/driver-preflights.ts';
import { selfOriginHandler } from '../../src/infra/browsers/host-interception.ts';
import {
  fixedOwner,
  InterceptionChain,
  type InterceptionHandler,
  PASS,
} from '../../src/infra/browsers/interception-chain.ts';
import { requestGuardHandler } from '../../src/infra/browsers/request-guard-route.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { err } from '../../src/kernel/result.ts';
import { type FixtureServer, startFixtureServer } from '../helpers/fixture-server.ts';
import { integrationChannel } from '../helpers/integration-channel.ts';
import { type LaunchedSession, useDriverFixtures } from './driver-fixture.ts';

const clock = createSystemClock();

interface FetchOptions {
  readonly method?: string;
  /** Adds `content-type: application/json` and `x-custom` (both need a preflight). */
  readonly preflighted?: boolean;
  readonly credentials?: RequestCredentials;
}

/** `fetch` from the page: `ok:<status>` when the page could read the answer, else `err:<name>`. */
function pageFetch(page: Page, url: string, options: FetchOptions = {}): Promise<string> {
  return page.evaluate(
    ({ url, method, preflighted, credentials }) =>
      fetch(url, {
        method,
        credentials,
        ...(method === 'GET' ? {} : { body: preflighted ? '{}' : 'x' }),
        ...(preflighted
          ? { headers: { 'content-type': 'application/json', 'x-custom': '1' } }
          : {}),
      }).then(
        (r) => `ok:${r.status}`,
        (e: Error) => `err:${e.name}`,
      ),
    {
      url,
      method: options.method ?? 'POST',
      preflighted: options.preflighted ?? true,
      credentials: options.credentials ?? 'same-origin',
    },
  );
}

/** What reached `server` under `prefix`, as `METHOD` strings in order. */
function methods(server: FixtureServer, prefix: string): string[] {
  return server.requests.filter((r) => r.path.startsWith(prefix)).map((r) => r.method);
}

function ruleSet(...inputs: RequestGuardRuleInput[]): RequestGuardRuleSet {
  const compiled = compileRequestGuardRules(inputs);
  if (!compiled.ok) throw new Error(`bad fixture: ${compiled.error.reason}`);
  return new RequestGuardRuleSet(compiled.value);
}

/** A chain of the (empty) blocklist and the request guard over `rules`, installed on `context`. */
async function guardChain(context: BrowserContext, sessionId: string, rules = ruleSet()) {
  const hits = new InMemoryRequestGuardHits();
  const logger = createCollectingLogger();
  const handlers: InterceptionHandler[] = [
    blocklistHandler({
      blocklist: new Blocklist(),
      observer: { blocked: () => undefined },
      sessionId,
      clock,
      logger,
    }),
    requestGuardHandler({ rules, hits, confirmer: null, clock, logger }),
  ];
  const chain = new InterceptionChain({
    handlers,
    resolveOwner: fixedOwner(sessionId),
    clock,
    logger,
  });
  expect((await chain.install(context)).ok).toBe(true);
  expect(chain.preflightsEnforced).toBe(true);
  return { chain, hits, logger };
}

describe('real CORS preflights under a BrowserHive route (D-66, real Chromium)', () => {
  const { state } = useDriverFixtures();

  /** The two routes an exclusive session can have: the blocklist route, and the guard's chain. */
  const routes = {
    blocklist: async (session: LaunchedSession) => {
      const warning = await installBlocklistRoute(session.handle.context, {
        blocklist: new Blocklist(),
        observer: { blocked: () => undefined },
        sessionId: session.view.sessionId,
        clock,
        logger: createCollectingLogger(),
      });
      expect(warning).toBeNull();
    },
    guard: async (session: LaunchedSession) => {
      await guardChain(session.handle.context, session.view.sessionId);
    },
  } as const;

  it('a chain installed before the first page of a fresh process enforces preflights there too', async () => {
    // Its own process: in this one an earlier test has already wrapped the driver's network
    // manager, which is what the first page of a daemon's first routed session must do itself.
    const other = startFixtureServer();
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, '..', 'helpers', 'preflight-first-page.ts'),
          state.fixture.url('/'),
          other.url('/cors/write'),
          integrationChannel(),
        ],
        { stdout: 'pipe', stderr: 'pipe', env: process.env },
      );
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(code).toBe(0);
      expect(JSON.parse(out.trim())).toEqual({
        pagesBefore: 0,
        installed: true,
        armed: true,
        page: 'err:TypeError',
      });
      expect(methods(other, '/cors/')).toEqual(['OPTIONS']);
    } finally {
      other.stop();
    }
  });

  for (const stealth of [false, true]) {
    const label = stealth ? 'stealth' : 'plain';

    for (const [routeName, install] of Object.entries(routes)) {
      const leg = `${label}, ${routeName} route`;

      it(`[${leg}] a write the site refuses at preflight is never sent; one it allows is sent once`, async () => {
        const other = startFixtureServer();
        try {
          const session = await state.launch({ slug: `cors-${routeName}-${label}`, stealth });
          await install(session);
          expect(hasPreflightHook(session.handle.context)).toBe(true);
          await session.page.goto(state.fixture.url('/'));

          expect(await pageFetch(session.page, other.url('/cors/write'))).toBe('err:TypeError');
          expect(methods(other, '/cors/')).toEqual(['OPTIONS']);

          expect(await pageFetch(session.page, other.url('/cors-allowed/write'))).toBe('ok:200');
          expect(methods(other, '/cors-allowed/')).toEqual(['OPTIONS', 'POST']);

          // The preflight is the site's, sent by Chromium: the page's origin and the asked method
          // and headers, never a cookie.
          const preflight = other.requests.find((r) => r.method === 'OPTIONS');
          expect(preflight?.headers).toMatchObject({
            origin: state.fixture.url('/').replace(/\/$/, ''),
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type,x-custom',
          });
          expect(preflight?.headers['cookie']).toBeUndefined();
        } finally {
          other.stop();
        }
      });
    }

    it(`[${label}] simple cross-origin requests need no preflight and are sent as before`, async () => {
      const other = startFixtureServer();
      try {
        const session = await state.launch({ slug: `cors-simple-${label}`, stealth });
        await routes.guard(session);
        await session.page.goto(state.fixture.url('/'));
        // A GET the site allows (`*`): readable.
        expect(
          await pageFetch(session.page, other.url('/cors-allowed/read'), {
            method: 'GET',
            preflighted: false,
          }),
        ).toBe('ok:200');
        // A text/plain POST the site never allows: sent (no preflight), unreadable, as in Chrome.
        expect(
          await pageFetch(session.page, other.url('/cors/simple'), { preflighted: false }),
        ).toBe('err:TypeError');
        expect(other.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
          'GET /cors-allowed/read',
          'POST /cors/simple',
        ]);
      } finally {
        other.stop();
      }
    });

    it(`[${label}] a credentialed write answered with Access-Control-Allow-Origin: * is refused`, async () => {
      const other = startFixtureServer();
      try {
        const session = await state.launch({ slug: `cors-cred-${label}`, stealth });
        await routes.guard(session);
        await session.page.goto(state.fixture.url('/'));
        expect(
          await pageFetch(session.page, other.url('/cors-allowed/cred'), {
            credentials: 'include',
          }),
        ).toBe('err:TypeError');
        expect(methods(other, '/cors-allowed/')).toEqual(['OPTIONS']);
        // The same answer suffices for an uncredentialed write; a site that names the origin and
        // allows credentials gets the credentialed one.
        expect(await pageFetch(session.page, other.url('/cors-allowed/anon'))).toBe('ok:200');
        expect(
          await pageFetch(session.page, other.url('/cors-cached/cred'), { credentials: 'include' }),
        ).toBe('ok:200');
        expect(methods(other, '/cors-allowed/')).toEqual(['OPTIONS', 'OPTIONS', 'POST']);
        expect(methods(other, '/cors-cached/')).toEqual(['OPTIONS', 'POST']);
      } finally {
        other.stop();
      }
    });

    it(`[${label}] the site's preflight answer is reused for its max-age, per question`, async () => {
      const other = startFixtureServer();
      try {
        const session = await state.launch({ slug: `cors-cache-${label}`, stealth });
        const { chain } = await guardChain(session.handle.context, session.view.sessionId);
        await session.page.goto(state.fixture.url('/'));
        for (let i = 0; i < 3; i++) {
          expect(await pageFetch(session.page, other.url('/cors-cached/a'))).toBe('ok:200');
        }
        expect(methods(other, '/cors-cached/a')).toEqual(['OPTIONS', 'POST', 'POST', 'POST']);
        expect(chain.preflights.size).toBe(1);
        // Another method is another question.
        expect(await pageFetch(session.page, other.url('/cors-cached/a'), { method: 'PUT' })).toBe(
          'ok:200',
        );
        expect(methods(other, '/cors-cached/a').slice(4)).toEqual(['OPTIONS', 'PUT']);
        // `Access-Control-Max-Age: 0`: asked every time.
        for (let i = 0; i < 2; i++) {
          expect(await pageFetch(session.page, other.url('/cors-nocache/b'))).toBe('ok:200');
        }
        expect(methods(other, '/cors-nocache/b')).toEqual(['OPTIONS', 'POST', 'OPTIONS', 'POST']);
        // A refusal is never kept: asked again.
        for (let i = 0; i < 2; i++) {
          expect(await pageFetch(session.page, other.url('/cors/c'))).toBe('err:TypeError');
        }
        expect(methods(other, '/cors/c')).toEqual(['OPTIONS', 'OPTIONS']);
      } finally {
        other.stop();
      }
    });

    it(`[${label}] the guard decides on the write after the site's preflight and never sees the preflight`, async () => {
      const other = startFixtureServer();
      try {
        const session = await state.launch({ slug: `cors-guard-${label}`, stealth });
        const { hits } = await guardChain(
          session.handle.context,
          session.view.sessionId,
          ruleSet({
            id: 'any-method',
            // No `methods`: every method that reaches the route.
            url: `127.0.0.1:${other.port}/cors-allowed/*`,
            action: 'block',
          }),
        );
        await session.page.goto(state.fixture.url('/'));
        expect(await pageFetch(session.page, other.url('/cors-allowed/write'))).toBe(
          'err:TypeError',
        );
        // The site answered the preflight; the write it allowed was blocked by the guard.
        expect(methods(other, '/cors-allowed/')).toEqual(['OPTIONS']);
        await Bun.sleep(100);
        expect(hits.list().map((h) => `${h.action} ${h.method} ${h.resourceType}`)).toEqual([
          'block POST fetch',
        ]);
      } finally {
        other.stop();
      }
    });

    it(`[${label}] a preflight to BrowserHive's own origin is failed by the self-origin guard`, async () => {
      const self = startFixtureServer();
      try {
        const session = await state.launch({ slug: `cors-self-${label}`, stealth });
        const logger = createCollectingLogger();
        const chain = new InterceptionChain({
          handlers: [selfOriginHandler({ origins: [self.url('/')], logger })],
          resolveOwner: fixedOwner(session.view.sessionId),
          logger,
        });
        expect((await chain.install(session.handle.context)).ok).toBe(true);
        await session.page.goto(state.fixture.url('/'));
        expect(await pageFetch(session.page, self.url('/cors-allowed/write'))).toBe(
          'err:TypeError',
        );
        expect(self.requests).toEqual([]);
      } finally {
        self.stop();
      }
    });

    it(`[${label}] Chromium re-checks a replayed answer: a kept wildcard answer still refuses a credentialed write`, async () => {
      const other = startFixtureServer();
      try {
        const session = await state.launch({ slug: `cors-recheck-${label}`, stealth });
        await routes.guard(session);
        await session.page.goto(state.fixture.url('/'));
        // `/cors-allowed/` answers `Access-Control-Allow-Origin: *` without max-age (kept 5 s).
        expect(await pageFetch(session.page, other.url('/cors-allowed/x'))).toBe('ok:200');
        expect(
          await pageFetch(session.page, other.url('/cors-allowed/x'), { credentials: 'include' }),
        ).toBe('err:TypeError');
        // The second write got the kept answer (no second OPTIONS) and Chromium refused it.
        expect(methods(other, '/cors-allowed/x')).toEqual(['OPTIONS', 'POST']);
      } finally {
        other.stop();
      }
    });

    it(`[${label}] an answer that refuses an asked header is not kept: the site is asked every time`, async () => {
      const other = startFixtureServer();
      try {
        const session = await state.launch({ slug: `cors-narrow-${label}`, stealth });
        const { chain } = await guardChain(session.handle.context, session.view.sessionId);
        await session.page.goto(state.fixture.url('/'));
        for (let i = 0; i < 2; i++) {
          expect(await pageFetch(session.page, other.url('/cors-narrow/a'))).toBe('err:TypeError');
        }
        expect(methods(other, '/cors-narrow/a')).toEqual(['OPTIONS', 'OPTIONS']);
        expect(chain.preflights.size).toBe(0);
      } finally {
        other.stop();
      }
    });

    it(`[${label}] a page's own OPTIONS request is routed to the guard, never taken as a preflight`, async () => {
      const session = await state.launch({ slug: `cors-own-${label}`, stealth });
      const hits = new InMemoryRequestGuardHits();
      const logger = createCollectingLogger();
      const preflights: string[] = [];
      const counting: InterceptionHandler = {
        id: 'self-origin',
        onError: 'open',
        handle: async () => PASS,
        preflight: async (preflight) => {
          preflights.push(preflight.url);
          return PASS;
        },
      };
      const chain = new InterceptionChain({
        handlers: [
          counting,
          requestGuardHandler({
            rules: ruleSet({
              id: 'api',
              url: `127.0.0.1:${state.fixture.port}/api/*`,
              action: 'block',
            }),
            hits,
            confirmer: null,
            clock,
            logger,
          }),
        ],
        resolveOwner: fixedOwner(session.view.sessionId),
        clock,
        logger,
      });
      expect((await chain.install(session.handle.context)).ok).toBe(true);
      await session.page.goto(state.fixture.url('/'));
      expect(
        await pageFetch(session.page, state.fixture.url('/api/own'), {
          method: 'OPTIONS',
          preflighted: false,
        }),
      ).toBe('err:TypeError');
      await Bun.sleep(100);
      expect(state.fixture.requests.filter((r) => r.path === '/api/own')).toEqual([]);
      expect(hits.list().map((h) => `${h.action} ${h.method} ${h.resourceType}`)).toEqual([
        'block OPTIONS fetch',
      ]);
      expect(preflights).toEqual([]);
    });

    it(`[${label}] without an armed hook the chain fails closed: preflighted requests never leave`, async () => {
      const other = startFixtureServer();
      try {
        const session = await state.launch({ slug: `cors-closed-${label}`, stealth });
        const logger = createCollectingLogger();
        const chain = new InterceptionChain({
          handlers: [],
          resolveOwner: fixedOwner(session.view.sessionId),
          clock,
          logger,
          // As when the driver is not a verified version: the driver answers every preflight.
          installPreflights: () => err(new Error('cors preflights not enforced: driver_version')),
        });
        expect((await chain.install(session.handle.context)).ok).toBe(true);
        expect(chain.preflightsEnforced).toBe(false);
        await session.page.goto(state.fixture.url('/'));
        // Refused and allowed alike: the driver answered the preflight, so the chain refuses.
        expect(await pageFetch(session.page, other.url('/cors/write'))).toBe('err:TypeError');
        expect(await pageFetch(session.page, other.url('/cors-allowed/write'))).toBe(
          'err:TypeError',
        );
        expect(other.requests).toEqual([]);
        // Simple and same-origin requests still work.
        expect(
          await pageFetch(session.page, other.url('/cors-allowed/read'), {
            method: 'GET',
            preflighted: false,
          }),
        ).toBe('ok:200');
        expect(
          await pageFetch(session.page, state.fixture.url('/api/same'), { method: 'PUT' }),
        ).toBe('ok:200');
        expect(logger.has('cors request refused')).toBe(true);
      } finally {
        other.stop();
      }
    });
  }
});

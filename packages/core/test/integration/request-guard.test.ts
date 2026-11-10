/// <reference lib="dom" />
/** @module test/integration/request-guard — the interception chain and the method-aware request guard on real Chromium: form, fetch and beacon posts, documents, the blocklist in the same chain, held confirmations, the HTTP cache and the documented redirect limit (spec 13 §3.8, §9.3, T0b; issue #59). */

import { describe, expect, it } from 'bun:test';
import type { Page } from 'playwright';
import { Blocklist, parseBlocklist } from '../../src/domain/policies/blocklist.ts';
import {
  compileRequestGuardRules,
  type RequestGuardRuleInput,
  RequestGuardRuleSet,
  type RequestGuardRuleSource,
} from '../../src/domain/policies/request-guard.ts';
import { InMemoryRequestGuardHits } from '../../src/domain/policies/request-guard-hits.ts';
import {
  blocklistHandler,
  installBlocklistRoute,
} from '../../src/infra/browsers/blocklist-route.ts';
import {
  fixedOwner,
  InterceptionChain,
  type InterceptionHandler,
} from '../../src/infra/browsers/interception-chain.ts';
import { requestGuardHandler } from '../../src/infra/browsers/request-guard-route.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import type { RequestConfirmer, RequestConfirmResult } from '../../src/ports/request-guard.ts';
import type { FixtureServer } from '../helpers/fixture-server.ts';
import { type LaunchedSession, useDriverFixtures } from './driver-fixture.ts';

const clock = createSystemClock();

function ruleSet(...inputs: RequestGuardRuleInput[]): RequestGuardRuleSet {
  const compiled = compileRequestGuardRules(inputs);
  if (!compiled.ok) throw new Error(`bad fixture: ${compiled.error.reason}`);
  return new RequestGuardRuleSet(compiled.value);
}

/** The fixture's `host:port`, the host part of every rule below. */
function hostOf(fixture: FixtureServer): string {
  return `127.0.0.1:${fixture.port}`;
}

/** Installs a chain of the blocklist (when given) and the guard on the session's context. */
async function guard(
  session: LaunchedSession,
  rules: RequestGuardRuleSource,
  options: { blocklist?: string; confirmer?: RequestConfirmer } = {},
) {
  const hits = new InMemoryRequestGuardHits();
  const logger = createCollectingLogger();
  const handlers: InterceptionHandler[] = [];
  if (options.blocklist !== undefined) {
    const parsed = parseBlocklist(options.blocklist);
    if (!parsed.ok) throw new Error('bad blocklist');
    handlers.push(
      blocklistHandler({
        blocklist: new Blocklist(parsed.value),
        observer: { blocked: () => undefined },
        sessionId: session.handle.sessionId,
        clock,
        logger,
      }),
    );
  }
  handlers.push(
    requestGuardHandler({
      rules,
      hits,
      confirmer: options.confirmer ?? null,
      clock,
      logger,
    }),
  );
  const chain = new InterceptionChain({
    handlers,
    resolveOwner: fixedOwner(session.handle.sessionId),
    logger,
  });
  const installed = await chain.install(session.handle.context);
  expect(installed.ok).toBe(true);
  return { hits, logger };
}

/** `fetch` from the page: the status, or `blocked:<error name>` when the request was aborted. */
function pageFetch(page: Page, path: string, method: string): Promise<string> {
  return page.evaluate(
    ({ path, method }) =>
      fetch(path, { method, body: method === 'GET' ? null : 'x' }).then(
        (r) => String(r.status),
        (e: Error) => `blocked:${e.name}`,
      ),
    { path, method },
  );
}

/** How many requests the fixture server saw for `method path`. */
function seen(fixture: FixtureServer, method: string, path: string): number {
  return fixture.requests.filter((r) => r.method === method && r.path === path).length;
}

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

describe('request guard (real Chromium)', () => {
  const { state } = useDriverFixtures();

  for (const stealth of [false, true]) {
    const driver = stealth ? 'patchright' : 'playwright';

    it(`[${driver}] a POST form logout is aborted while the GET confirm page loads`, async () => {
      const session = await state.launch({ slug: `form-${driver}`, stealth });
      const { hits } = await guard(
        session,
        ruleSet({
          id: 'logout',
          url: `${hostOf(state.fixture)}/logout`,
          methods: ['POST'],
          action: 'block',
        }),
      );
      const page = session.page;
      const shown = await page.goto(state.fixture.url('/logout'));
      expect(shown?.status()).toBe(200);
      await page.click('#sign-out', { noWaitAfter: true });
      // The aborted form POST commits Chromium's error page; wait for it so it cannot interrupt
      // the next `goto` (seen on macOS CI).
      // (`waitForURL` rejects with the navigation's own error, so poll the committed URL.)
      expect(await waitFor(() => page.url().startsWith('chrome-error:'))).toBe(true);
      await page.waitForLoadState('load').catch(() => undefined);
      expect(seen(state.fixture, 'POST', '/logout')).toBe(0);
      expect(await page.locator('#signed-out').count()).toBe(0);
      expect(hits.list()).toEqual([
        expect.objectContaining({
          sessionId: session.handle.sessionId,
          ruleId: 'logout',
          action: 'block',
          method: 'POST',
          resourceType: 'document',
          url: `${state.fixture.origin}/logout`,
        }),
      ]);
      // A GET form to the same URL is not a POST and loads.
      await page.goto(state.fixture.url('/logout'));
      await Promise.all([page.waitForURL('**/logout?'), page.click('#search-go')]);
      expect(await page.locator('#logout').count()).toBe(1);
    });

    it(`[${driver}] a fetch POST is aborted, its GET and an unrelated POST pass`, async () => {
      const session = await state.launch({ slug: `fetch-${driver}`, stealth });
      const { hits } = await guard(
        session,
        ruleSet({
          id: 'api-logout',
          url: `${hostOf(state.fixture)}/api/logout`,
          methods: ['POST'],
          action: 'block',
        }),
      );
      await session.page.goto(state.fixture.url('/'));
      expect(await pageFetch(session.page, '/api/logout', 'POST')).toBe('blocked:TypeError');
      expect(await pageFetch(session.page, '/api/logout', 'GET')).toBe('200');
      expect(await pageFetch(session.page, '/api/other', 'POST')).toBe('200');
      expect(seen(state.fixture, 'POST', '/api/logout')).toBe(0);
      expect(seen(state.fixture, 'GET', '/api/logout')).toBe(1);
      expect(hits.list().map((h) => [h.method, h.resourceType])).toEqual([['POST', 'fetch']]);
    });

    it(`[${driver}] a beacon is a ping: matched by default, not by a fetch-only rule`, async () => {
      const session = await state.launch({ slug: `beacon-${driver}`, stealth });
      const { hits } = await guard(
        session,
        ruleSet(
          { id: 'beacon', url: `${hostOf(state.fixture)}/api/beacon`, action: 'block' },
          {
            id: 'fetch-only',
            url: `${hostOf(state.fixture)}/api/track`,
            resourceTypes: ['fetch', 'xhr'],
            action: 'block',
          },
        ),
      );
      await session.page.goto(state.fixture.url('/'));
      await session.page.evaluate(() => {
        navigator.sendBeacon('/api/beacon', 'bye');
        navigator.sendBeacon('/api/track', 'hello');
      });
      expect(await waitFor(() => seen(state.fixture, 'POST', '/api/track') === 1)).toBe(true);
      expect(await waitFor(() => hits.list().length === 1)).toBe(true);
      await Bun.sleep(200);
      expect(seen(state.fixture, 'POST', '/api/beacon')).toBe(0);
      expect(hits.list().map((h) => [h.ruleId, h.method, h.resourceType])).toEqual([
        ['beacon', 'POST', 'ping'],
      ]);
    });
  }

  it('a rule without methods blocks a GET document load', async () => {
    const session = await state.launch({ slug: 'getdoc' });
    const { hits } = await guard(
      session,
      ruleSet({
        id: 'elements',
        url: `${hostOf(state.fixture)}/elements`,
        resourceTypes: ['document'],
        action: 'block',
      }),
    );
    // A fetch of the URL is not a document. (Checked first: a blocked navigation commits
    // Chromium's error page, which would interrupt a later `goto`.)
    await session.page.goto(state.fixture.url('/'));
    expect(await pageFetch(session.page, '/elements', 'GET')).toBe('200');
    const failure = await session.page.goto(state.fixture.url('/elements')).then(
      () => 'loaded',
      (e: Error) => e.message,
    );
    expect(failure).toContain('net::ERR_BLOCKED_BY_CLIENT');
    expect(seen(state.fixture, 'GET', '/elements')).toBe(1);
    expect(hits.list().map((h) => h.resourceType)).toEqual(['document']);
  });

  it('a guard that throws aborts documents and lets subresources through', async () => {
    const session = await state.launch({ slug: 'throws' });
    await session.page.goto(state.fixture.url('/'));
    const { logger } = await guard(session, {
      rulesFor: () => {
        throw new Error('rule source exploded');
      },
    });
    expect(await pageFetch(session.page, '/api/write', 'POST')).toBe('200');
    const failure = await session.page.goto(state.fixture.url('/elements')).then(
      () => 'loaded',
      (e: Error) => e.message,
    );
    expect(failure).toContain('net::ERR_FAILED');
    expect(logger.has('interception handler threw')).toBe(true);
  });

  it('the blocklist runs first in the same chain; the guard sees what it passes', async () => {
    const session = await state.launch({ slug: 'chain' });
    const { hits } = await guard(
      session,
      ruleSet({
        id: 'api-delete',
        url: `${hostOf(state.fixture)}/api/delete`,
        methods: ['POST', 'DELETE'],
        action: 'block',
      }),
      { blocklist: `${hostOf(state.fixture)}/elements\n` },
    );
    await session.page.goto(state.fixture.url('/'));
    // The blocklist governs documents only: a fetch of a blocked URL passes it.
    expect(await pageFetch(session.page, '/elements', 'GET')).toBe('200');
    expect(await pageFetch(session.page, '/api/delete', 'DELETE')).toBe('blocked:TypeError');
    const blocked = await session.page.goto(state.fixture.url('/elements')).then(
      () => 'loaded',
      (e: Error) => e.message,
    );
    expect(blocked).toContain('net::ERR_BLOCKED_BY_CLIENT');
    expect(hits.list().map((h) => h.ruleId)).toEqual(['api-delete']);
  });

  it('a confirm rule holds the request until the operator answers', async () => {
    const session = await state.launch({ slug: 'confirm' });
    const answers: Array<(result: RequestConfirmResult) => void> = [];
    const confirmer: RequestConfirmer = {
      confirm: () => new Promise((resolve) => answers.push(resolve)),
    };
    const { hits } = await guard(
      session,
      ruleSet({
        id: 'write',
        url: `${hostOf(state.fixture)}/api/write`,
        methods: ['POST'],
        action: 'confirm',
      }),
      { confirmer },
    );
    await session.page.goto(state.fixture.url('/'));
    const approved = pageFetch(session.page, '/api/write', 'POST');
    expect(await waitFor(() => answers.length === 1)).toBe(true);
    await Bun.sleep(200);
    expect(seen(state.fixture, 'POST', '/api/write')).toBe(0);
    answers[0]?.({ outcome: 'approved', decidedBy: 'operator', requestId: 'req-1' });
    expect(await approved).toBe('200');
    expect(seen(state.fixture, 'POST', '/api/write')).toBe(1);

    const denied = pageFetch(session.page, '/api/write', 'POST');
    expect(await waitFor(() => answers.length === 2)).toBe(true);
    answers[1]?.({ outcome: 'denied', decidedBy: 'operator', requestId: 'req-2' });
    expect(await denied).toBe('blocked:TypeError');
    expect(seen(state.fixture, 'POST', '/api/write')).toBe(1);
    expect(hits.list().map((h) => h.outcome)).toEqual(['approved', 'denied']);
  });

  it('documented limit: a redirect hop to a guarded URL is not routed (spec 13 §3.8)', async () => {
    const session = await state.launch({ slug: 'redirect' });
    const { hits } = await guard(
      session,
      ruleSet({
        id: 'logout-page',
        url: `${hostOf(state.fixture)}/logout`,
        methods: ['GET'],
        action: 'block',
      }),
    );
    // Playwright routes only the first URL of a redirect chain: `/redirect` passes, its 302 to
    // `/logout` is followed without a route call. Packs block known redirectors instead (§9.3).
    const response = await session.page.goto(state.fixture.url('/redirect?to=/logout'));
    expect(response?.url()).toBe(state.fixture.url('/logout'));
    expect(seen(state.fixture, 'GET', '/logout')).toBe(1);
    expect(hits.list()).toEqual([]);
    // The same URL requested directly is blocked.
    const direct = await session.page.goto(state.fixture.url('/logout')).then(
      () => 'loaded',
      (e: Error) => e.message,
    );
    expect(direct).toContain('net::ERR_BLOCKED_BY_CLIENT');
  });
});

describe('interception and the HTTP cache (real Chromium)', () => {
  const { state } = useDriverFixtures();

  /** Two `force-cache` fetches of `/cached`; how many reached the server. */
  async function cachedFetches(page: Page): Promise<number> {
    await page.goto(state.fixture.url('/'));
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => fetch('/cached', { cache: 'force-cache' }).then((r) => r.text()));
    }
    return seen(state.fixture, 'GET', '/cached');
  }

  it('a session without a route keeps its HTTP cache', async () => {
    const session = await state.launch({ slug: 'cache-on' });
    expect(await cachedFetches(session.page)).toBe(1);
  });

  it('installing the chain (a configured blocklist, even empty) disables it', async () => {
    const session = await state.launch({ slug: 'cache-off' });
    const warning = await installBlocklistRoute(session.handle.context, {
      blocklist: new Blocklist(),
      observer: { blocked: () => undefined },
      sessionId: session.handle.sessionId,
      clock,
      logger: createCollectingLogger(),
    });
    expect(warning).toBeNull();
    expect(await cachedFetches(session.page)).toBe(2);
  });
});

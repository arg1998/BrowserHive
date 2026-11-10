/** @module infra/browsers/request-guard-route.test — the request guard's actions, held confirmations, fail-closed matched requests, sanitized hits and its place after the blocklist in one chain (spec 13 §3.8, §9.3). */

import { describe, expect, it } from 'bun:test';
import type { Request, Route } from 'playwright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { Blocklist, parseBlocklist } from '../../domain/policies/blocklist.ts';
import {
  compileRequestGuardRules,
  type RequestGuardRuleInput,
  RequestGuardRuleSet,
  type RequestGuardRules,
} from '../../domain/policies/request-guard.ts';
import type {
  RequestConfirmation,
  RequestConfirmer,
  RequestConfirmResult,
  RequestOwner,
} from '../../ports/request-guard.ts';
import { InMemoryRequestGuardHits } from '../audit/in-memory-guard-hits.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import { type BlockedUrlHit, blocklistHandler } from './blocklist-route.ts';
import { fixedOwner, InterceptionChain, type OwnerResolver } from './interception-chain.ts';
import { type RequestGuardHandlerDeps, requestGuardHandler } from './request-guard-route.ts';

/** Lets the hits recorded after the owner resolves land. */
const flush = () => Bun.sleep(0);

function rules(...inputs: RequestGuardRuleInput[]): RequestGuardRuleSet {
  const result = compileRequestGuardRules(inputs);
  if (!result.ok) throw new Error('bad fixture');
  return new RequestGuardRuleSet(result.value);
}

function fakeRoute(method: string, resourceType: string, url: string) {
  const outcome: string[] = [];
  const request: unknown = {
    url: () => url,
    method: () => method,
    resourceType: () => resourceType,
  };
  const route: unknown = {
    request: () => request,
    fallback: async () => void outcome.push('fallback'),
    abort: async (reason: string) => void outcome.push(`abort:${reason}`),
  };
  return { route: route as Route, request: request as Request, outcome };
}

/** A confirmer answering `outcome`, recording what it was asked; `gate` holds the answer. */
function fakeConfirmer(answer: RequestConfirmResult | Error, gate?: Promise<void>) {
  const asked: RequestConfirmation[] = [];
  const confirmer: RequestConfirmer = {
    confirm: async (request) => {
      asked.push(request);
      if (gate !== undefined) await gate;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { confirmer, asked };
}

function setup(
  source: RequestGuardHandlerDeps['rules'],
  options: {
    confirmer?: RequestConfirmer | null;
    resolveOwner?: OwnerResolver;
    hits?: RequestGuardHandlerDeps['hits'];
  } = {},
) {
  const hits = new InMemoryRequestGuardHits();
  const logger = createCollectingLogger();
  const guard = requestGuardHandler({
    rules: source,
    hits: options.hits ?? hits,
    confirmer: options.confirmer ?? null,
    clock: new FakeClock(5_000),
    logger,
    urlQueryAllowlist: ['page'],
  });
  const chain = new InterceptionChain({
    handlers: [guard],
    resolveOwner: options.resolveOwner ?? fixedOwner('sess-1'),
    logger,
  });
  // `handle`, then let the hits that are recorded once the owner resolves land.
  const settled = {
    handle: async (route: Route) => {
      await chain.handle(route);
      await flush();
    },
  };
  return { chain: settled, hits, logger };
}

const LOGOUT: RequestGuardRuleInput = {
  id: 'logout',
  url: 'site.test/logout',
  methods: ['POST'],
  action: 'block',
};

describe('requestGuardHandler', () => {
  it('blocks a matching request with blockedbyclient and records a sanitized hit', async () => {
    const { chain, hits } = setup(rules(LOGOUT));
    const { route, outcome } = fakeRoute(
      'post',
      'fetch',
      'https://user:pw@site.test/logout/x?token=s3cret&page=2#frag',
    );
    await chain.handle(route);
    expect(outcome).toEqual(['abort:blockedbyclient']);
    expect(hits.list()).toEqual([
      {
        sessionId: 'sess-1',
        ruleId: 'logout',
        ruleAction: 'block',
        action: 'block',
        outcome: null,
        decidedBy: null,
        requestId: null,
        method: 'POST',
        resourceType: 'fetch',
        url: 'https://site.test/logout/x?page=2',
        source: 'request',
        ts: 5_000,
      },
    ]);
  });

  it('passes requests no rule matches, without resolving the owner or recording anything', async () => {
    let owners = 0;
    const { chain, hits } = setup(rules(LOGOUT), {
      resolveOwner: async () => {
        owners += 1;
        return { kind: 'host' };
      },
    });
    for (const [method, type] of [
      ['GET', 'document'],
      ['POST', 'image'],
    ] as const) {
      const { route, outcome } = fakeRoute(method, type, 'https://site.test/logout');
      await chain.handle(route);
      expect(outcome).toEqual(['fallback']);
    }
    expect(owners).toBe(0);
    expect(hits.list()).toEqual([]);
  });

  it('warn passes and records; allow passes silently and stops the search', async () => {
    const { chain, hits } = setup(
      rules(
        { id: 'allowed', url: 'site.test/api/ok', action: 'allow' },
        { id: 'noted', url: 'site.test/api/*', action: 'warn' },
      ),
    );
    const allowed = fakeRoute('POST', 'xhr', 'https://site.test/api/ok');
    await chain.handle(allowed.route);
    const warned = fakeRoute('POST', 'ping', 'https://site.test/api/track');
    await chain.handle(warned.route);
    expect(allowed.outcome).toEqual(['fallback']);
    expect(warned.outcome).toEqual(['fallback']);
    expect(hits.list().map((h) => [h.ruleId, h.action, h.resourceType])).toEqual([
      ['noted', 'warn', 'ping'],
    ]);
  });

  it('confirm without a confirmer acts as block (stdio, no confirmation flow)', async () => {
    const { chain, hits } = setup(
      rules({ id: 'write', url: 'site.test/post', methods: ['POST'], action: 'confirm' }),
    );
    const { route, outcome } = fakeRoute('POST', 'document', 'https://site.test/post');
    await chain.handle(route);
    expect(outcome).toEqual(['abort:blockedbyclient']);
    expect(hits.list()[0]).toMatchObject({ ruleAction: 'confirm', action: 'block', outcome: null });
  });

  it('confirm holds the request until the operator answers; approved passes', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { confirmer, asked } = fakeConfirmer(
      { outcome: 'approved', decidedBy: 'operator-a', requestId: 'req-1' },
      gate,
    );
    const owner: RequestOwner = { kind: 'host' };
    const { chain, hits } = setup(
      rules({ id: 'write', url: 'site.test/post*', action: 'confirm' }),
      { confirmer, resolveOwner: async () => owner },
    );
    const { route, outcome } = fakeRoute('POST', 'fetch', 'https://site.test/post?secret=1');
    const handled = chain.handle(route);
    await Bun.sleep(5);
    expect(outcome).toEqual([]);
    expect(asked).toEqual([
      {
        owner,
        ruleId: 'write',
        method: 'POST',
        resourceType: 'fetch',
        url: 'https://site.test/post',
        signal: expect.any(AbortSignal),
      },
    ]);
    release();
    await handled;
    expect(outcome).toEqual(['fallback']);
    expect(hits.list()[0]).toMatchObject({
      sessionId: null,
      action: 'confirm',
      outcome: 'approved',
      decidedBy: 'operator-a',
      requestId: 'req-1',
    });
  });

  for (const outcome of ['denied', 'timeout', 'cancelled'] as const) {
    it(`confirm answered ${outcome} aborts the request`, async () => {
      const { confirmer } = fakeConfirmer({ outcome, decidedBy: null, requestId: 'req-2' });
      const { chain, hits } = setup(
        rules({ id: 'write', url: 'site.test/post', action: 'confirm' }),
        { confirmer },
      );
      const route = fakeRoute('POST', 'xhr', 'https://site.test/post');
      await chain.handle(route.route);
      expect(route.outcome).toEqual(['abort:blockedbyclient']);
      expect(hits.list()[0]?.outcome).toBe(outcome);
    });
  }

  it('a matched request whose confirmation fails is aborted whatever its type', async () => {
    const { confirmer } = fakeConfirmer(new Error('broker down'));
    const { chain, logger, hits } = setup(
      rules({ id: 'write', url: 'site.test/post', action: 'confirm' }),
      { confirmer },
    );
    const { route, outcome } = fakeRoute('POST', 'fetch', 'https://site.test/post');
    await chain.handle(route);
    expect(outcome).toEqual(['abort:failed']);
    expect(logger.has('request guard failed')).toBe(true);
    expect(hits.list()).toEqual([]);
  });

  it('a block whose owner cannot be resolved is still blocked, its hit without a session', async () => {
    const { chain, hits } = setup(rules(LOGOUT), {
      resolveOwner: async () => {
        throw new Error('no page');
      },
    });
    const { route, outcome } = fakeRoute('POST', 'ping', 'https://site.test/logout');
    await chain.handle(route);
    await flush();
    expect(outcome).toEqual(['abort:blockedbyclient']);
    expect(hits.list().map((h) => [h.ruleId, h.sessionId])).toEqual([['logout', null]]);
  });

  it('a confirm whose owner cannot be resolved is aborted with failed', async () => {
    const { confirmer, asked } = fakeConfirmer({
      outcome: 'approved',
      decidedBy: null,
      requestId: null,
    });
    const { chain } = setup(rules({ id: 'write', url: 'site.test/post', action: 'confirm' }), {
      confirmer,
      resolveOwner: async () => {
        throw new Error('no page');
      },
    });
    const { route, outcome } = fakeRoute('POST', 'fetch', 'https://site.test/post');
    await chain.handle(route);
    expect(outcome).toEqual(['abort:failed']);
    expect(asked).toEqual([]);
  });

  it('allow never resolves the owner; block aborts before the owner resolves', async () => {
    let asked = 0;
    let resolveOwner = (_owner: RequestOwner): void => undefined;
    const { chain, hits } = setup(
      rules(
        { id: 'ok', url: 'site.test/ok', action: 'allow' },
        { id: 'no', url: 'site.test/no', action: 'block' },
      ),
      {
        resolveOwner: () => {
          asked += 1;
          return new Promise((resolve) => {
            resolveOwner = resolve;
          });
        },
      },
    );
    const allowed = fakeRoute('POST', 'fetch', 'https://site.test/ok');
    await chain.handle(allowed.route);
    expect(allowed.outcome).toEqual(['fallback']);
    expect(asked).toBe(0);
    const blocked = fakeRoute('POST', 'fetch', 'https://site.test/no');
    await chain.handle(blocked.route);
    expect(blocked.outcome).toEqual(['abort:blockedbyclient']);
    await flush();
    expect(hits.list()).toEqual([]);
    resolveOwner({ kind: 'session', sessionId: 'late' });
    await flush();
    expect(hits.list().map((h) => [h.ruleId, h.sessionId])).toEqual([['no', 'late']]);
  });

  it('a rule set with an action the guard does not know fails closed (never hangs)', async () => {
    const compiledRules = compileRequestGuardRules([LOGOUT]);
    if (!compiledRules.ok) throw new Error('bad fixture');
    const [rule] = compiledRules.value.rules;
    if (rule === undefined) throw new Error('bad fixture');
    // As a rule source that skipped the compiler would hand it over: an unresolved write policy.
    const unresolved = { ...rule, action: 'write_policy' as unknown as 'block' };
    const { chain, logger } = setup({ rulesFor: () => ({ rules: [unresolved] }) });
    const { route, outcome } = fakeRoute('POST', 'fetch', 'https://site.test/logout');
    await chain.handle(route);
    expect(outcome).toEqual(['abort:failed']);
    expect(logger.has('request guard failed')).toBe(true);
  });

  it('a hit sink that throws does not change the decision', async () => {
    const { chain, logger } = setup(rules(LOGOUT), {
      hits: {
        record: () => {
          throw new Error('sink full');
        },
      },
    });
    const { route, outcome } = fakeRoute('POST', 'fetch', 'https://site.test/logout');
    await chain.handle(route);
    expect(outcome).toEqual(['abort:blockedbyclient']);
    expect(logger.has('guard hit not recorded')).toBe(true);
  });

  it('a rule source that throws fails closed for documents only (the chain rule)', async () => {
    const broken = {
      rulesFor: (): RequestGuardRules => {
        throw new Error('registry exploded');
      },
    };
    const { chain } = setup(broken);
    const doc = fakeRoute('GET', 'document', 'https://site.test/');
    const sub = fakeRoute('POST', 'fetch', 'https://site.test/api');
    await chain.handle(doc.route);
    await chain.handle(sub.route);
    expect(doc.outcome).toEqual(['abort:failed']);
    expect(sub.outcome).toEqual(['fallback']);
  });

  it('reads the current rules on every request (hot reload)', async () => {
    const source = rules();
    const { chain } = setup(source);
    const before = fakeRoute('POST', 'fetch', 'https://site.test/logout');
    await chain.handle(before.route);
    const next = compileRequestGuardRules([LOGOUT]);
    if (!next.ok) throw new Error('bad fixture');
    source.replace(next.value);
    const after = fakeRoute('POST', 'fetch', 'https://site.test/logout');
    await chain.handle(after.route);
    expect(before.outcome).toEqual(['fallback']);
    expect(after.outcome).toEqual(['abort:blockedbyclient']);
  });
});

describe('blocklist then request guard in one chain', () => {
  function chainWithBoth() {
    const parsed = parseBlocklist('site.test/private\n');
    if (!parsed.ok) throw new Error('bad fixture');
    const blocked: BlockedUrlHit[] = [];
    const clock = new FakeClock(1_000);
    const logger = createCollectingLogger();
    const guardHits = new InMemoryRequestGuardHits();
    const chain = new InterceptionChain({
      handlers: [
        blocklistHandler({
          blocklist: new Blocklist(parsed.value),
          observer: { blocked: (hit) => void blocked.push(hit) },
          sessionId: 'sess-1',
          clock,
          logger,
        }),
        requestGuardHandler({
          rules: rules({ id: 'all-private', url: 'site.test/private', action: 'block' }, LOGOUT),
          hits: guardHits,
          confirmer: null,
          clock,
          logger,
        }),
      ],
      resolveOwner: fixedOwner('sess-1'),
      logger,
    });
    const settled = {
      handle: async (route: Route) => {
        await chain.handle(route);
        await flush();
      },
    };
    return { chain: settled, blocked, guardHits };
  }

  it('a document the blocklist blocks is the blocklist hit; the guard never sees it', async () => {
    const { chain, blocked, guardHits } = chainWithBoth();
    const { route, outcome } = fakeRoute('GET', 'document', 'https://site.test/private');
    await chain.handle(route);
    expect(outcome).toEqual(['abort:blockedbyclient']);
    expect(blocked.map((h) => h.pattern)).toEqual(['site.test/private']);
    expect(guardHits.list()).toEqual([]);
  });

  it('a subresource the blocklist passes reaches the guard', async () => {
    const { chain, blocked, guardHits } = chainWithBoth();
    const priv = fakeRoute('GET', 'fetch', 'https://site.test/private');
    const logout = fakeRoute('POST', 'document', 'https://site.test/logout');
    await chain.handle(priv.route);
    await chain.handle(logout.route);
    expect(priv.outcome).toEqual(['abort:blockedbyclient']);
    expect(logout.outcome).toEqual(['abort:blockedbyclient']);
    expect(blocked).toEqual([]);
    expect(guardHits.list().map((h) => h.ruleId)).toEqual(['all-private', 'logout']);
  });
});

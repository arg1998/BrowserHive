/** @module infra/browsers/interception-chain.test — one route per context, ordered handlers, first abort wins, fail-closed and fail-open handler errors, lazy memoized owner (spec 13 §3.8). */

import { describe, expect, it } from 'bun:test';
import type { BrowserContext, Request, Route } from 'playwright';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import {
  fixedOwner,
  InterceptionChain,
  type InterceptionHandler,
  type InterceptionVerdict,
  PASS,
} from './interception-chain.ts';

type RouteHandler = (route: Route) => Promise<void>;

/** A fake context that records every route it is given. */
function fakeContext(options: { failInstall?: boolean } = {}) {
  const routes: { pattern: string; handler: RouteHandler }[] = [];
  const context: unknown = {
    route: async (pattern: string, handler: RouteHandler) => {
      if (options.failInstall === true) throw new Error('route unsupported');
      routes.push({ pattern, handler });
    },
  };
  return { context: context as BrowserContext, routes };
}

/** A fake route recording what the chain did with it. */
function fakeRoute(resourceType: string | (() => string), options: { noRequest?: boolean } = {}) {
  const outcome: string[] = [];
  const request: unknown = {
    url: () => 'https://site.test/x',
    method: () => 'POST',
    resourceType: typeof resourceType === 'function' ? resourceType : () => resourceType,
  };
  const route: unknown = {
    request: () => {
      if (options.noRequest === true) throw new Error('gone');
      return request;
    },
    fallback: async () => void outcome.push('fallback'),
    abort: async (reason: string) => void outcome.push(`abort:${reason}`),
  };
  return { route: route as Route, request: request as Request, outcome };
}

/** A handler that records its calls and answers `verdict` (or throws it). */
function handler(
  id: InterceptionHandler['id'],
  calls: string[],
  verdict: InterceptionVerdict | Error,
  onError: InterceptionHandler['onError'] = 'closed',
): InterceptionHandler {
  return {
    id,
    onError,
    handle: async () => {
      calls.push(id);
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
}

const ABORT: InterceptionVerdict = { kind: 'abort', reason: 'blockedbyclient' };

function chainOf(handlers: InterceptionHandler[], logger = createCollectingLogger()) {
  return new InterceptionChain({ handlers, resolveOwner: fixedOwner('sess-1'), logger });
}

describe('InterceptionChain', () => {
  it('installs exactly one **/* route; installing again is a no-op, another context is refused', async () => {
    const { context, routes } = fakeContext();
    const chain = chainOf([handler('blocklist', [], PASS)]);
    expect((await chain.install(context)).ok).toBe(true);
    expect(routes.map((r) => r.pattern)).toEqual(['**/*']);
    expect((await chain.install(context)).ok).toBe(true);
    expect(routes).toHaveLength(1);
    const other = fakeContext();
    expect((await chain.install(other.context)).ok).toBe(false);
    expect(other.routes).toHaveLength(0);
  });

  it('runs handlers in the fixed slot order whatever order they are given in', async () => {
    const calls: string[] = [];
    const chain = chainOf([
      handler('request-guard', calls, PASS),
      handler('blocklist', calls, PASS),
      handler('self-origin', calls, PASS),
    ]);
    expect(chain.handlers.map((h) => h.id)).toEqual(['self-origin', 'blocklist', 'request-guard']);
    await chain.handle(fakeRoute('fetch').route);
    expect(calls).toEqual(['self-origin', 'blocklist', 'request-guard']);
  });

  it('register adds a handler in its slot; the disposer removes exactly it; one per id', async () => {
    const calls: string[] = [];
    const chain = chainOf([handler('request-guard', calls, PASS)]);
    const added = chain.register(handler('blocklist', calls, PASS));
    if (!added.ok) throw added.error;
    expect(chain.register(handler('blocklist', calls, PASS)).ok).toBe(false);
    await chain.handle(fakeRoute('fetch').route);
    expect(calls).toEqual(['blocklist', 'request-guard']);
    added.value();
    added.value();
    calls.length = 0;
    await chain.handle(fakeRoute('fetch').route);
    expect(calls).toEqual(['request-guard']);
    expect(chain.register(handler('blocklist', calls, PASS)).ok).toBe(true);
  });

  it('a handler returning no verdict is treated as one that threw (never leaves the route open)', async () => {
    const broken: InterceptionHandler = {
      id: 'request-guard',
      onError: 'closed',
      handle: async () => undefined as unknown as InterceptionVerdict,
    };
    const doc = fakeRoute('document');
    const sub = fakeRoute('fetch');
    const logger = createCollectingLogger();
    await chainOf([broken], logger).handle(doc.route);
    await chainOf([broken]).handle(sub.route);
    expect(doc.outcome).toEqual(['abort:failed']);
    expect(sub.outcome).toEqual(['fallback']);
    expect(logger.has('interception handler threw')).toBe(true);
  });

  it("aborts a held request's signal when Chromium fails it or the context closes", async () => {
    const listeners = new Map<string, (arg: unknown) => void>();
    const context: unknown = {
      route: async () => undefined,
      on: (event: string, listener: (arg: unknown) => void) => void listeners.set(event, listener),
    };
    const signals: AbortSignal[] = [];
    const releases: Array<() => void> = [];
    const holding: InterceptionHandler = {
      id: 'request-guard',
      onError: 'closed',
      handle: async (_request, ctx) => {
        signals.push(ctx.signal());
        await new Promise<void>((resolve) => releases.push(resolve));
        return PASS;
      },
    };
    const chain = chainOf([holding]);
    await chain.install(context as BrowserContext);
    const first = fakeRoute('fetch');
    const second = fakeRoute('fetch');
    const done = [chain.handle(first.route), chain.handle(second.route)];
    await Bun.sleep(0);
    expect(listeners.size).toBe(2);
    listeners.get('requestfailed')?.(first.request);
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    listeners.get('close')?.(undefined);
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    for (const release of releases) release();
    await Promise.all(done);
  });

  it('subscribes to context events only once a handler holds a request', async () => {
    const { context } = fakeContext();
    const chain = chainOf([handler('blocklist', [], PASS)]);
    await chain.install(context);
    // The fake context has no `on`: a chain that never holds a request never calls it.
    await chain.handle(fakeRoute('document').route);
  });

  it('returns the install error instead of throwing', async () => {
    const { context } = fakeContext({ failInstall: true });
    const result = await chainOf([]).install(context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });

  it('runs handlers in order and falls back once when every handler passes', async () => {
    const calls: string[] = [];
    const chain = chainOf([
      handler('self-origin', calls, PASS),
      handler('blocklist', calls, PASS),
      handler('request-guard', calls, PASS),
    ]);
    const { route, outcome } = fakeRoute('fetch');
    await chain.handle(route);
    expect(calls).toEqual(['self-origin', 'blocklist', 'request-guard']);
    expect(outcome).toEqual(['fallback']);
  });

  it('the first abort ends the chain; later handlers never see the request', async () => {
    const calls: string[] = [];
    const chain = chainOf([
      handler('blocklist', calls, ABORT),
      handler('request-guard', calls, PASS),
    ]);
    const { route, outcome } = fakeRoute('document');
    await chain.handle(route);
    expect(calls).toEqual(['blocklist']);
    expect(outcome).toEqual(['abort:blockedbyclient']);
  });

  it('a fail-closed handler that throws aborts a document with failed', async () => {
    const calls: string[] = [];
    const logger = createCollectingLogger();
    const chain = chainOf(
      [handler('blocklist', calls, new Error('boom')), handler('request-guard', calls, PASS)],
      logger,
    );
    const { route, outcome } = fakeRoute('document');
    await chain.handle(route);
    expect(outcome).toEqual(['abort:failed']);
    expect(calls).toEqual(['blocklist']);
    expect(logger.find('interception handler threw').at(-1)?.all).toMatchObject({
      handler: 'blocklist',
    });
  });

  it('a fail-closed handler that throws on a subresource hands it to the next handler', async () => {
    const calls: string[] = [];
    const chain = chainOf([
      handler('blocklist', calls, new Error('boom')),
      handler('request-guard', calls, PASS),
    ]);
    const { route, outcome } = fakeRoute('fetch');
    await chain.handle(route);
    expect(calls).toEqual(['blocklist', 'request-guard']);
    expect(outcome).toEqual(['fallback']);
  });

  it('a fail-open handler that throws never aborts, not even a document', async () => {
    const chain = chainOf([handler('request-guard', [], new Error('boom'), 'open')]);
    const { route, outcome } = fakeRoute('document');
    await chain.handle(route);
    expect(outcome).toEqual(['fallback']);
  });

  it('a request whose type cannot be read is not failed closed', async () => {
    const chain = chainOf([handler('request-guard', [], new Error('boom'))]);
    const { route, outcome } = fakeRoute(() => {
      throw new Error('gone');
    });
    await chain.handle(route);
    expect(outcome).toEqual(['fallback']);
  });

  it('a route without a request falls back', async () => {
    const calls: string[] = [];
    const chain = chainOf([handler('blocklist', calls, ABORT)]);
    const { route, outcome } = fakeRoute('document', { noRequest: true });
    await chain.handle(route);
    expect(calls).toEqual([]);
    expect(outcome).toEqual(['fallback']);
  });

  it('a route that fails to abort or fall back does not throw', async () => {
    const chain = chainOf([handler('blocklist', [], ABORT)]);
    const route: unknown = {
      request: () => ({ resourceType: () => 'document' }),
      fallback: async () => {
        throw new Error('gone');
      },
      abort: async () => {
        throw new Error('gone');
      },
    };
    await chain.handle(route as Route);
    const passing = chainOf([handler('blocklist', [], PASS)]);
    await passing.handle(route as Route);
  });

  it('resolves the owner lazily, at most once per request', async () => {
    let resolved = 0;
    const owners: unknown[] = [];
    const asksOwner = (id: InterceptionHandler['id']): InterceptionHandler => ({
      id,
      onError: 'closed',
      handle: async (_request, context) => {
        owners.push(await context.owner());
        return PASS;
      },
    });
    const chain = new InterceptionChain({
      handlers: [asksOwner('blocklist'), asksOwner('request-guard')],
      resolveOwner: async () => {
        resolved += 1;
        return { kind: 'session', sessionId: 'sess-9' };
      },
      logger: createCollectingLogger(),
    });
    await chain.handle(fakeRoute('fetch').route);
    expect(resolved).toBe(1);
    expect(owners).toEqual([
      { kind: 'session', sessionId: 'sess-9' },
      { kind: 'session', sessionId: 'sess-9' },
    ]);
    const silent = new InterceptionChain({
      handlers: [handler('blocklist', [], PASS)],
      resolveOwner: async () => {
        resolved += 1;
        return { kind: 'host' };
      },
      logger: createCollectingLogger(),
    });
    await silent.handle(fakeRoute('fetch').route);
    expect(resolved).toBe(1);
  });

  it('fixedOwner gives every request the one session', async () => {
    const { request } = fakeRoute('fetch');
    expect(await fixedOwner('sess-2')(request)).toEqual({ kind: 'session', sessionId: 'sess-2' });
  });
});

/** @module infra/browsers/chain-preflights.test — the chain's preflight side (D-66): the hook armed before the route, preflight decisions in slot order, and fail-closed refusal of preflighted requests while preflights are not enforced. */

import { describe, expect, it } from 'bun:test';
import type { BrowserContext, Request, Route } from 'patchright';
import { err, ok } from '../../kernel/result.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import type { PreflightInstaller } from './chain-preflights.ts';
import type { PreflightHook, PreflightRequest } from './driver-preflights.ts';
import {
  fixedOwner,
  InterceptionChain,
  type InterceptionHandler,
  type InterceptionVerdict,
  PASS,
} from './interception-chain.ts';
import type { PreflightEnforcementState } from './preflight-enforcement.ts';

const PREFLIGHT: PreflightRequest = {
  url: 'https://api.site.test/write',
  origin: 'https://site.test',
  requestMethod: 'POST',
  requestHeaders: 'content-type',
};

const ABORT: InterceptionVerdict = { kind: 'abort', reason: 'blockedbyclient' };

/** A handler deciding preflights only (its `handle` passes). */
function preflightHandler(
  id: InterceptionHandler['id'],
  calls: string[],
  verdict: InterceptionVerdict | Error,
  onError: InterceptionHandler['onError'] = 'closed',
): InterceptionHandler {
  return {
    id,
    onError,
    handle: async () => PASS,
    preflight: async (preflight) => {
      calls.push(`${id}:${preflight.url}`);
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
}

function chainOf(
  handlers: InterceptionHandler[],
  options: {
    logger?: ReturnType<typeof createCollectingLogger>;
    install?: PreflightInstaller;
    state?: () => PreflightEnforcementState;
  } = {},
) {
  return new InterceptionChain({
    handlers,
    resolveOwner: fixedOwner('sess-1'),
    logger: options.logger ?? createCollectingLogger(),
    installPreflights: options.install ?? (() => ok('armed')),
    preflightState: options.state ?? (() => 'enforced'),
  });
}

/** A fake context recording its route. */
function fakeContext() {
  const routes: ((route: Route) => Promise<void>)[] = [];
  const context: unknown = {
    route: async (_pattern: string, handler: (route: Route) => Promise<void>) => {
      routes.push(handler);
    },
  };
  return { context: context as BrowserContext, routes };
}

/** A routed request: a cross-origin JSON write by default. */
function routed(
  facts: {
    url?: string;
    method?: string;
    resourceType?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const outcome: string[] = [];
  const request: unknown = {
    url: () => facts.url ?? 'https://api.site.test/write',
    method: () => facts.method ?? 'POST',
    resourceType: () => facts.resourceType ?? 'fetch',
    headers: () =>
      facts.headers ?? { origin: 'https://site.test', 'content-type': 'application/json' },
  };
  const route: unknown = {
    request: () => request as Request,
    fallback: async () => void outcome.push('fallback'),
    abort: async (reason: string) => void outcome.push(`abort:${reason}`),
  };
  return { route: route as Route, outcome };
}

describe('InterceptionChain preflights (D-66)', () => {
  it('arms the preflight hook before the route, with its own decision and cache', async () => {
    const order: string[] = [];
    let hook: PreflightHook | null = null;
    const context: unknown = { route: async () => void order.push('route') };
    const chain = chainOf([], {
      install: (_context, given) => {
        order.push('preflights');
        hook = given;
        return ok('armed');
      },
    });
    expect(chain.preflightsEnforced).toBe(false);
    expect((await chain.install(context as BrowserContext)).ok).toBe(true);
    expect(order).toEqual(['preflights', 'route']);
    expect(chain.preflightsEnforced).toBe(true);
    const armed = hook as PreflightHook | null;
    expect(armed?.cache).toBe(chain.preflights);
    expect(await armed?.decide(PREFLIGHT)).toEqual({ kind: 'continue' });
  });

  it('enforcement follows the hook and the process: armed, pending until wrapped, refused never', async () => {
    let state: PreflightEnforcementState = 'enforced';
    const armed = chainOf([], { state: () => state });
    await armed.install(fakeContext().context);
    expect(armed.preflightsEnforced).toBe(true);
    state = 'refused';
    expect(armed.preflightsEnforced).toBe(false);

    state = 'pending';
    const pending = chainOf([], { install: () => ok('pending'), state: () => state });
    await pending.install(fakeContext().context);
    expect(pending.preflightsEnforced).toBe(false);
    state = 'enforced';
    expect(pending.preflightsEnforced).toBe(true);
  });

  it('a hook the driver cannot take is logged; the route still stands', async () => {
    const logger = createCollectingLogger();
    const { context, routes } = fakeContext();
    const chain = chainOf([], { logger, install: () => err(new Error('driver_version')) });
    expect((await chain.install(context)).ok).toBe(true);
    expect(routes).toHaveLength(1);
    expect(chain.preflightsEnforced).toBe(false);
    expect(logger.find('preflight hook unavailable')[0]?.level).toBe('error');

    const throwing = chainOf([], {
      install: () => {
        throw new Error('boom');
      },
    });
    expect((await throwing.install(fakeContext().context)).ok).toBe(true);
    expect(throwing.preflightsEnforced).toBe(false);
  });

  it('runs only the handlers that decide preflights, in slot order; the first abort wins', async () => {
    const calls: string[] = [];
    const guard: InterceptionHandler = {
      id: 'request-guard',
      onError: 'closed',
      handle: async () => {
        calls.push('request-guard');
        return ABORT;
      },
    };
    const chain = chainOf([
      guard,
      preflightHandler('blocklist', calls, PASS),
      preflightHandler('self-origin', calls, PASS),
    ]);
    expect(await chain.handlePreflight(PREFLIGHT)).toEqual({ kind: 'continue' });
    expect(calls).toEqual([`self-origin:${PREFLIGHT.url}`, `blocklist:${PREFLIGHT.url}`]);

    calls.length = 0;
    const aborting = chainOf([
      preflightHandler('self-origin', calls, ABORT),
      preflightHandler('blocklist', calls, PASS),
    ]);
    expect(await aborting.handlePreflight(PREFLIGHT)).toEqual(ABORT);
    expect(calls).toEqual([`self-origin:${PREFLIGHT.url}`]);
  });

  it('a throwing or malformed preflight decision fails the preflight for a closed handler only', async () => {
    const logger = createCollectingLogger();
    const closed = chainOf([preflightHandler('self-origin', [], new Error('boom'))], { logger });
    expect(await closed.handlePreflight(PREFLIGHT)).toEqual({ kind: 'abort', reason: 'failed' });
    expect(logger.has('interception handler threw')).toBe(true);

    const calls: string[] = [];
    const open = chainOf([
      preflightHandler('self-origin', calls, new Error('boom'), 'open'),
      preflightHandler('blocklist', calls, PASS),
    ]);
    expect(await open.handlePreflight(PREFLIGHT)).toEqual({ kind: 'continue' });
    expect(calls).toHaveLength(2);

    const malformed: InterceptionHandler = {
      id: 'self-origin',
      onError: 'closed',
      handle: async () => PASS,
      preflight: async () => ({ kind: 'continue' }) as unknown as InterceptionVerdict,
    };
    expect(await chainOf([malformed]).handlePreflight(PREFLIGHT)).toEqual({
      kind: 'abort',
      reason: 'failed',
    });
  });
});

describe('fail closed while preflights are not enforced (review F1)', () => {
  async function installed(state: PreflightEnforcementState, install?: PreflightInstaller) {
    const logger = createCollectingLogger();
    const calls: string[] = [];
    const guard: InterceptionHandler = {
      id: 'request-guard',
      onError: 'closed',
      handle: async (request) => {
        calls.push(`${request.method()} ${request.url()}`);
        return PASS;
      },
    };
    const { context, routes } = fakeContext();
    const chain = chainOf([guard], {
      logger,
      state: () => state,
      ...(install !== undefined && { install }),
    });
    await chain.install(context);
    const run = async (request: ReturnType<typeof routed>) => {
      await routes[0]?.(request.route);
      return request.outcome;
    };
    return { run, calls, logger };
  }

  it('refuses a cross-origin request that needs a preflight; lets the rest through', async () => {
    const { run, calls, logger } = await installed('refused');
    expect(await run(routed())).toEqual(['abort:failed']);
    expect(logger.find('cors request refused')[0]?.all).toMatchObject({
      method: 'POST',
      resourceType: 'fetch',
    });
    // Simple, same-origin and navigation requests go on to the handlers.
    expect(
      await run(routed({ headers: { origin: 'https://site.test', 'content-type': 'text/plain' } })),
    ).toEqual(['fallback']);
    expect(
      await run(routed({ method: 'PUT', headers: { origin: 'https://api.site.test' } })),
    ).toEqual(['fallback']);
    expect(await run(routed({ resourceType: 'document', method: 'PUT' }))).toEqual(['fallback']);
    expect(calls).toHaveLength(3);
  });

  it('applies when the hook could not be armed, and while it is pending', async () => {
    const failed = await installed('enforced', () => err(new Error('driver_version')));
    expect(await failed.run(routed())).toEqual(['abort:failed']);
    const pending = await installed('pending', () => ok('pending'));
    expect(await pending.run(routed())).toEqual(['abort:failed']);
    const enforced = await installed('enforced', () => ok('pending'));
    expect(await enforced.run(routed())).toEqual(['fallback']);
  });

  it('a request whose facts cannot be read is refused unless it is a navigation', async () => {
    const { run } = await installed('refused');
    const unreadable = routed();
    const request = (
      unreadable.route as unknown as { request: () => Record<string, unknown> }
    ).request();
    request['headers'] = () => {
      throw new Error('gone');
    };
    expect(await run(unreadable)).toEqual(['abort:failed']);
  });
});

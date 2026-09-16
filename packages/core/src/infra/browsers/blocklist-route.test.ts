/** @module infra/browsers/blocklist-route.test — document-only blocking, hot reload, fail-closed handler, install failure warning. */

import { describe, expect, it } from 'bun:test';
import type { BrowserContext, Route } from 'playwright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { Blocklist, parseBlocklist } from '../../domain/policies/blocklist.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import { type BlockedUrlHit, installBlocklistRoute } from './blocklist-route.ts';

type Handler = (route: Route) => Promise<void>;

/** A fake context that captures the route handler; `failInstall` simulates a driver refusal. */
function fakeContext(options: { failInstall?: boolean } = {}) {
  let handler: Handler | undefined;
  const context: unknown = {
    route: async (pattern: string, h: Handler) => {
      if (options.failInstall === true) throw new Error('route unsupported');
      expect(pattern).toBe('**/*');
      handler = h;
    },
  };
  return { context: context as BrowserContext, handler: () => handler };
}

/** A fake route recording the outcome. `resourceType` may throw to exercise the fail-closed path. */
function fakeRoute(url: string, resourceType: string | (() => string)) {
  const outcome: string[] = [];
  const route: unknown = {
    request: () => ({
      url: () => url,
      resourceType: typeof resourceType === 'function' ? resourceType : () => resourceType,
    }),
    fallback: async () => {
      outcome.push('fallback');
    },
    abort: async (reason: string) => {
      outcome.push(`abort:${reason}`);
    },
  };
  return { route: route as Route, outcome };
}

function rules(...patterns: string[]) {
  const parsed = parseBlocklist(patterns.join('\n'));
  if (!parsed.ok) throw new Error('bad fixture');
  return parsed.value;
}

describe('installBlocklistRoute', () => {
  const hits: BlockedUrlHit[] = [];
  const deps = (blocklist: Blocklist) => ({
    blocklist,
    observer: { blocked: (hit: BlockedUrlHit) => void hits.push(hit) },
    sessionId: 'sess-1',
    clock: new FakeClock(1_000),
    logger: createCollectingLogger(),
  });

  it('aborts a matching document request with blockedbyclient and reports the hit', async () => {
    hits.length = 0;
    const { context, handler } = fakeContext();
    const warning = await installBlocklistRoute(context, deps(new Blocklist(rules('ads.example'))));
    expect(warning).toBeNull();
    const { route, outcome } = fakeRoute('https://ads.example/pixel', 'document');
    await handler()?.(route);
    expect(outcome).toEqual(['abort:blockedbyclient']);
    expect(hits).toEqual([
      {
        sessionId: 'sess-1',
        url: 'https://ads.example/pixel',
        pattern: 'ads.example',
        source: 'request',
        ts: 1_000,
      },
    ]);
  });

  it('lets non-matching documents and every subresource through', async () => {
    hits.length = 0;
    const { context, handler } = fakeContext();
    await installBlocklistRoute(context, deps(new Blocklist(rules('ads.example'))));
    const doc = fakeRoute('https://fine.example/', 'document');
    const img = fakeRoute('https://ads.example/pixel.gif', 'image');
    await handler()?.(doc.route);
    await handler()?.(img.route);
    expect(doc.outcome).toEqual(['fallback']);
    expect(img.outcome).toEqual(['fallback']);
    expect(hits).toEqual([]);
  });

  it('reads the CURRENT rules on every request (hot reload, D-22)', async () => {
    const holder = new Blocklist();
    const { context, handler } = fakeContext();
    await installBlocklistRoute(context, deps(holder));
    const before = fakeRoute('https://later.example/', 'document');
    await handler()?.(before.route);
    expect(before.outcome).toEqual(['fallback']);
    holder.replace(rules('later.example'));
    const after = fakeRoute('https://later.example/', 'document');
    await handler()?.(after.route);
    expect(after.outcome).toEqual(['abort:blockedbyclient']);
  });

  it('fails CLOSED when the handler throws on a document request', async () => {
    const { context, handler } = fakeContext();
    const holder = new Blocklist(rules('x.example'));
    holder.match = () => {
      throw new Error('matcher exploded');
    };
    const logger = createCollectingLogger();
    await installBlocklistRoute(context, { ...deps(holder), logger });
    const { route, outcome } = fakeRoute('https://anything.example/', 'document');
    await handler()?.(route);
    expect(outcome).toEqual(['abort:failed']);
    expect(logger.has('blocklist handler threw')).toBe(true);
  });

  it('returns BLOCKLIST_ROUTE_FAILED when the route cannot be installed', async () => {
    const { context } = fakeContext({ failInstall: true });
    const warning = await installBlocklistRoute(context, deps(new Blocklist(rules('x'))));
    expect(warning?.code).toBe('BLOCKLIST_ROUTE_FAILED');
    expect(warning?.message).toContain('navigation tools are still checked');
  });
});

/** @module test/persistence/conformance-facts.test — tool calls, pages, screenshots, vault audit, blocklist audit, event log, analytics. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  blockedRequestRecord,
  pageRecord,
  screenshotRecord,
  sessionRecord,
  toolCallRecord,
  vaultAccessRecord,
} from './helpers.ts';
import { openMemory, type TestDb } from './setup.ts';

let t: TestDb;
beforeEach(async () => {
  t = await openMemory();
  await t.repos.sessions.insert(sessionRecord());
});
afterEach(async () => {
  await t.close();
});

describe('ToolCallRepository', () => {
  it('round-trips, joins slug and screenshot presence, filters and paginates', async () => {
    const a = toolCallRecord({ eventId: 'e-a', ts: 10, seq: 1 });
    const b = toolCallRecord({
      eventId: 'e-b',
      ts: 20,
      seq: 2,
      ok: false,
      errorCode: 'ELEMENT_NOT_FOUND',
      errorMessage: 'nope',
      tool: 'click',
      durationMs: 5,
    });
    const c = toolCallRecord({
      eventId: 'e-c',
      ts: 30,
      seq: 3,
      sessionId: null,
      tool: 'server_status',
      durationMs: 900,
    });
    await t.repos.toolCalls.insert(a);
    await t.repos.toolCalls.insert(a);
    await t.repos.toolCalls.insert(b);
    await t.repos.toolCalls.insert(c);
    await t.repos.screenshots.insert(screenshotRecord({ eventId: 'e-a' }));
    expect(await t.repos.toolCalls.get('e-a')).toEqual({
      ...a,
      sessionSlug: 'shop',
      hasScreenshot: true,
    });
    expect(await t.repos.toolCalls.get('e-c')).toEqual({
      ...c,
      sessionSlug: null,
      hasScreenshot: false,
    });
    const page = await t.repos.toolCalls.listBySession('shop-a1b2c3d4', { limit: 1, total: true });
    expect(page.items.map((r) => r.eventId)).toEqual(['e-b']);
    expect(page.total).toBe(2);
    const next = await t.repos.toolCalls.listBySession('shop-a1b2c3d4', {
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(next.items.map((r) => r.eventId)).toEqual(['e-a']);
    expect(next.nextCursor).toBeNull();
    expect((await t.repos.toolCalls.listAll({ ok: false })).items.map((r) => r.eventId)).toEqual([
      'e-b',
    ]);
    expect(
      (await t.repos.toolCalls.listAll({ tools: ['server_status'] })).items.map((r) => r.eventId),
    ).toEqual(['e-c']);
    expect(
      (await t.repos.toolCalls.listAll({ errorCodes: ['ELEMENT_NOT_FOUND'] })).items.length,
    ).toBe(1);
    expect((await t.repos.toolCalls.listAll({ q: 'nope' })).items.map((r) => r.eventId)).toEqual([
      'e-b',
    ]);
    expect((await t.repos.toolCalls.listAll({ since: 20, until: 30 })).items.length).toBe(2);
    // Session-less calls can be excluded (linkable rows only) or isolated.
    const ids = async (hasSession: boolean) =>
      (await t.repos.toolCalls.listAll({ hasSession })).items.map((r) => r.eventId);
    expect(await ids(true)).toEqual(['e-b', 'e-a']);
    expect(await ids(false)).toEqual(['e-c']);
    expect(
      (await t.repos.toolCalls.listAll({ sort: 'duration_ms', dir: 'asc' })).items.map(
        (r) => r.eventId,
      ),
    ).toEqual(['e-b', 'e-a', 'e-c']);
  });

  it('escapes LIKE wildcards in free text', async () => {
    await t.repos.toolCalls.insert(toolCallRecord({ eventId: 'e-1', errorMessage: '100% done' }));
    await t.repos.toolCalls.insert(
      toolCallRecord({ eventId: 'e-2', errorMessage: '100 done', seq: 2 }),
    );
    expect((await t.repos.toolCalls.listAll({ q: '100%' })).items.map((r) => r.eventId)).toEqual([
      'e-1',
    ]);
  });
});

describe('PageRepository', () => {
  it('lists, recents and top domains', async () => {
    await t.repos.pages.insert(pageRecord({ eventId: 'p1', ts: 1, domain: 'a.com' }));
    await t.repos.pages.insert(
      pageRecord({
        eventId: 'p2',
        ts: 2,
        domain: 'b.com',
        category: 'local',
        url: 'http://localhost/',
      }),
    );
    await t.repos.pages.insert(pageRecord({ eventId: 'p3', ts: 3, domain: 'a.com' }));
    await t.repos.pages.insert(
      pageRecord({ eventId: 'p4', ts: 4, domain: '', category: 'other', url: 'about:blank' }),
    );
    expect((await t.repos.pages.recent(2)).map((p) => p.eventId)).toEqual(['p4', 'p3']);
    expect(
      (await t.repos.pages.list({ categories: ['local'] })).items.map((p) => p.eventId),
    ).toEqual(['p2']);
    expect(
      (await t.repos.pages.list({ domain: 'A.COM', sort: 'ts', dir: 'asc' })).items.map(
        (p) => p.eventId,
      ),
    ).toEqual(['p1', 'p3']);
    expect((await t.repos.pages.list({ q: 'localhost' })).items.map((p) => p.sessionSlug)).toEqual([
      'shop',
    ]);
    expect(await t.repos.pages.topDomains({ limit: 5 })).toEqual([
      { domain: 'a.com', count: 2 },
      { domain: 'b.com', count: 1 },
    ]);
    expect(await t.repos.pages.topDomains({ since: 2 })).toEqual([
      { domain: 'a.com', count: 1 },
      { domain: 'b.com', count: 1 },
    ]);
    expect(await t.analytics.topDomains({ limit: 1 })).toEqual([{ domain: 'a.com', count: 2 }]);
  });

  it('counts category facets disjunctively', async () => {
    await t.repos.pages.insert(pageRecord({ eventId: 'p1', ts: 1, domain: 'a.com' }));
    await t.repos.pages.insert(pageRecord({ eventId: 'p2', ts: 2, domain: 'a.com' }));
    await t.repos.pages.insert(
      pageRecord({ eventId: 'p3', ts: 3, domain: 'b.com', category: 'local' }),
    );
    await t.repos.pages.insert(
      pageRecord({ eventId: 'p4', ts: 4, domain: '', category: 'other', url: 'about:blank' }),
    );
    const publicCategory = (await t.repos.pages.list({})).items[3]?.category ?? 'public';
    expect(await t.repos.pages.facets({ categories: ['local'] })).toEqual({
      categories: [
        { value: 'local', count: 1 },
        { value: 'other', count: 1 },
        { value: publicCategory, count: 2 },
      ].sort((x, y) => x.value.localeCompare(y.value)),
    });
    expect(await t.repos.pages.facets({ since: 3 })).toEqual({
      categories: [
        { value: 'local', count: 1 },
        { value: 'other', count: 1 },
      ],
    });
    expect(await t.repos.pages.facets({ domain: 'a.com' })).toEqual({
      categories: [{ value: publicCategory, count: 2 }],
    });
  });
});

describe('ScreenshotRepository', () => {
  it('requires the parent tool call and lists by session', async () => {
    let error: unknown;
    try {
      await t.repos.screenshots.insert(screenshotRecord({ eventId: 'orphan' }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    await t.repos.toolCalls.insert(toolCallRecord({ eventId: 'e-1', tool: 'screenshot' }));
    await t.repos.screenshots.insert(screenshotRecord({ eventId: 'e-1', kind: 'tool' }));
    expect(await t.repos.screenshots.get('e-1')).toEqual({
      ...screenshotRecord({ eventId: 'e-1', kind: 'tool' }),
      tool: 'screenshot',
    });
    expect(
      (await t.repos.screenshots.listBySession('shop-a1b2c3d4', { kinds: ['tool'] })).items.length,
    ).toBe(1);
    expect(
      (await t.repos.screenshots.listBySession('shop-a1b2c3d4', { kinds: ['trace'] })).items.length,
    ).toBe(0);
  });
});

describe('VaultAuditRepository and BlocklistAuditRepository', () => {
  it('lists vault access with filters', async () => {
    await t.repos.vaultAudit.insert(vaultAccessRecord({ eventId: 'v1', ts: 1 }));
    await t.repos.vaultAudit.insert(
      vaultAccessRecord({
        eventId: 'v2',
        ts: 2,
        result: 'denied',
        originCheck: 'fail',
        evaluateEnabled: true,
        details: { why: 'x' },
      }),
    );
    const all = await t.repos.vaultAudit.list({ total: true });
    expect(all.items.map((v) => v.eventId)).toEqual(['v2', 'v1']);
    expect(all.items[0]?.details).toEqual({ why: 'x' });
    expect(all.items[0]?.sessionSlug).toBe('shop');
    expect((await t.repos.vaultAudit.list({ results: ['denied'] })).items.length).toBe(1);
    expect((await t.repos.vaultAudit.list({ originChecks: ['pass'] })).items.length).toBe(1);
    expect((await t.repos.vaultAudit.list({ evaluate: 'on' })).items.map((v) => v.eventId)).toEqual(
      ['v2'],
    );
    expect(
      (
        await t.repos.vaultAudit.list({ entryName: 'github', sort: 'result', dir: 'asc' })
      ).items.map((v) => v.eventId),
    ).toEqual(['v2', 'v1']);
  });

  it('lists blocked requests and computes stats', async () => {
    await t.repos.blocklistAudit.insert(blockedRequestRecord({ eventId: 'b1', ts: 1 }));
    await t.repos.blocklistAudit.insert(
      blockedRequestRecord({
        eventId: 'b2',
        ts: 2,
        domain: 'x.io',
        pattern: 'x.io',
        source: 'tool',
        tool: 'navigate',
      }),
    );
    await t.repos.blocklistAudit.insert(
      blockedRequestRecord({ eventId: 'b3', ts: 3, sessionId: null, domain: null }),
    );
    expect(
      (await t.repos.blocklistAudit.list({ sources: ['tool'] })).items.map((b) => b.eventId),
    ).toEqual(['b2']);
    expect((await t.repos.blocklistAudit.list({ pattern: '*.example.net' })).items.length).toBe(2);
    expect(
      (await t.repos.blocklistAudit.list({ q: 'pixel', sort: 'domain', dir: 'asc' })).items.length,
    ).toBe(3);
    const stats = await t.repos.blocklistAudit.stats({ since: 2 });
    expect(stats).toEqual({
      attempts: 2,
      sessions: 1,
      domains: 1,
      totalAllTime: 3,
      topPatterns: [
        { pattern: '*.example.net', count: 1, lastTs: 3 },
        { pattern: 'x.io', count: 1, lastTs: 2 },
      ],
      topDomains: [{ domain: 'x.io', count: 1 }],
    });
  });
});

describe('EventLogRepository', () => {
  it('appends with monotonic seq, dedupes ids and replays', async () => {
    const ev = {
      eventId: 'e-1',
      type: 'session.opened',
      sessionId: 'shop-a1b2c3d4',
      tenantId: null,
      actorKind: 'agent' as const,
      actorId: 'local',
      occurredAt: 1,
      traceId: null,
      payload: { a: 1 },
    };
    expect(await t.repos.events.append(ev)).toBe(1);
    expect(
      await t.repos.events.append({ ...ev, eventId: 'e-2', sessionId: null, occurredAt: 2 }),
    ).toBe(2);
    expect(await t.repos.events.append(ev)).toBe(1);
    expect(await t.repos.events.head()).toBe(2);
    const replay = await t.repos.events.replay(0, 10);
    expect(replay.map((e) => e.seq)).toEqual([1, 2]);
    expect(replay[0]).toEqual({ seq: 1, ...ev });
    expect((await t.repos.events.replay(1, 10)).map((e) => e.eventId)).toEqual(['e-2']);
    expect((await t.repos.events.replay(0, 10, 'shop-a1b2c3d4')).length).toBe(1);
  });
});

describe('AnalyticsQueries', () => {
  it('buckets activity, computes metrics, summary, timeline and size', async () => {
    await t.repos.toolCalls.insert(
      toolCallRecord({ eventId: 'e-1', ts: 60_000, durationMs: 10, seq: 1 }),
    );
    await t.repos.toolCalls.insert(
      toolCallRecord({
        eventId: 'e-2',
        ts: 61_000,
        durationMs: 30,
        ok: false,
        errorCode: 'X',
        seq: 2,
      }),
    );
    await t.repos.toolCalls.insert(
      toolCallRecord({ eventId: 'e-3', ts: 130_000, durationMs: 20, tool: 'click', seq: 3 }),
    );
    await t.repos.pages.insert(pageRecord({ eventId: 'p-1', ts: 62_000 }));
    await t.repos.blocklistAudit.insert(blockedRequestRecord({ eventId: 'b-1', ts: 125_000 }));
    const activity = await t.analytics.activity({
      since: 60_000,
      until: 180_000,
      bucketMs: 60_000,
      groupBy: 'tool',
    });
    expect(activity.window).toEqual({ since: 60_000, until: 180_000, bucketMs: 60_000 });
    expect(activity.buckets.map((b) => [b.ts, b.toolCalls, b.errors, b.blocked])).toEqual([
      [60_000, 2, 1, 0],
      [120_000, 1, 0, 1],
      [180_000, 0, 0, 0],
    ]);
    expect(activity.buckets[0]?.groups).toEqual({ navigate: 2 });
    const metrics = await t.analytics.toolMetrics({ groupBy: 'tool' });
    expect(metrics).toEqual([
      {
        tool: 'navigate',
        errorCode: null,
        calls: 2,
        errors: 1,
        errorRate: 0.5,
        p50Ms: 10,
        p95Ms: 30,
        p99Ms: 30,
        maxMs: 30,
      },
      {
        tool: 'click',
        errorCode: null,
        calls: 1,
        errors: 0,
        errorRate: 0,
        p50Ms: 20,
        p95Ms: 20,
        p99Ms: 20,
        maxMs: 20,
      },
    ]);
    expect((await t.analytics.toolMetrics({ groupBy: 'tool,error_code' })).length).toBe(3);
    const summary = await t.analytics.summary(200_000, 100_000);
    expect(summary).toMatchObject({
      sessionsTotal: 1,
      sessionsLive: 1,
      toolCallsTotal: 3,
      toolCallsWindow: 1,
      errorsTotal: 1,
      errorsWindow: 0,
      blockedTotal: 1,
      blockedWindow: 1,
      attentionOpen: 0,
    });
    const timeline = await t.analytics.timeline('shop-a1b2c3d4', { limit: 3 });
    expect(timeline.items.map((i) => [i.kind, i.id])).toEqual([
      ['tool', 'tool:e-3'],
      ['blocked', 'blocked:b-1'],
      ['page', 'page:p-1'],
    ]);
    const rest = await t.analytics.timeline('shop-a1b2c3d4', {
      limit: 3,
      cursor: timeline.nextCursor,
    });
    expect(rest.items.map((i) => i.id)).toEqual(['tool:e-2', 'tool:e-1']);
    expect(rest.nextCursor).toBeNull();
    expect(
      (await t.analytics.timeline('shop-a1b2c3d4', { errorsOnly: true })).items.map((i) => i.id),
    ).toEqual(['blocked:b-1', 'tool:e-2']);
    expect(await t.analytics.databaseSize()).toBeGreaterThan(0);
  });

  it('gives a tool call and its page row distinct ids, pages them stably and searches', async () => {
    // navigate: the page row reuses the tool call's event id and timestamp.
    await t.repos.toolCalls.insert(
      toolCallRecord({ eventId: 'e-nav', ts: 5_000, tool: 'navigate', seq: 1 }),
    );
    await t.repos.pages.insert(
      pageRecord({ eventId: 'e-nav', ts: 5_000, url: 'https://shop.example/cart' }),
    );
    await t.repos.toolCalls.insert(
      toolCallRecord({
        eventId: 'e-soft',
        ts: 6_000,
        tool: 'click',
        ok: true,
        errorCode: 'ELEMENT_NOT_ACTIONABLE',
        seq: 2,
      }),
    );
    const first = await t.analytics.timeline('shop-a1b2c3d4', { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(['tool:e-soft', 'tool:e-nav']);
    const second = await t.analytics.timeline('shop-a1b2c3d4', {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((i) => i.id)).toEqual(['page:e-nav']);
    expect(second.nextCursor).toBeNull();
    // Soft failures (ok, but with an error code) are errors too.
    expect(
      (await t.analytics.timeline('shop-a1b2c3d4', { errorsOnly: true })).items.map((i) => i.id),
    ).toEqual(['tool:e-soft']);
    expect(
      (await t.analytics.timeline('shop-a1b2c3d4', { q: 'cart' })).items.map((i) => i.id),
    ).toEqual(['page:e-nav']);
    expect(
      (await t.analytics.timeline('shop-a1b2c3d4', { q: 'not_actionable' })).items.map((i) => i.id),
    ).toEqual(['tool:e-soft']);
  });
});

/** @module test/persistence/conformance-timeline.test — the session timeline's guard rows (spec 13 §11.1): guard hits beside security intercepts and attention, paging with ties on `ts`, and `q` and `errors_only` filtered before the page cut (review PR #83 M7). */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { sessionRecord } from './helpers.ts';
import { openMemory, type TestDb } from './setup.ts';

let t: TestDb;
beforeEach(async () => {
  t = await openMemory();
  await t.repos.sessions.insert(sessionRecord());
});
afterEach(async () => {
  await t.close();
});

describe('AnalyticsQueries timeline: guard rows', () => {
  it('lists the session guard hits (kind guard) and its security intercepts beside attention', async () => {
    const hit = (eventId: string, ts: number, over: Record<string, unknown> = {}) => ({
      eventId,
      sessionId: 'shop-a1b2c3d4',
      templateId: 'tp-aaaaaaaaaa',
      packId: 'site-a.test',
      guardId: 'logout',
      guardKind: 'logout' as const,
      action: 'block' as const,
      outcome: null,
      decidedBy: null,
      source: 'request' as const,
      method: 'POST',
      url: 'https://www.site-a.test/logout',
      requestId: null,
      tool: null,
      ts,
      ...over,
    });
    await t.repos.siteGuardHits.insert(hit('g-1', 1_000));
    await t.repos.siteGuardHits.insert(hit('g-2', 2_000, { action: 'warn', guardId: 'feed' }));
    await t.repos.siteGuardHits.insert(
      hit('g-3', 3_000, { action: 'confirm', outcome: 'approved', guardId: 'invite' }),
    );
    await t.repos.siteGuardHits.insert(hit('g-x', 4_000, { sessionId: null }));
    await t.repos.operatorRequests.insert({
      requestId: 'a-000000000001',
      kind: 'security_intercept',
      sessionId: 'shop-a1b2c3d4',
      owner: 'agent-1',
      reason: 'Site A security check',
      mode: 'takeover',
      entryName: null,
      tool: null,
      toolEventId: null,
      pageUrl: null,
      options: null,
      idempotencyKey: null,
      createdAt: 5_000,
      deadlineAt: null,
      templateId: 'tp-aaaaaaaaaa',
    });
    const all = await t.analytics.timeline('shop-a1b2c3d4', {});
    expect(all.items.map((i) => i.id)).toEqual([
      'attention:a-000000000001',
      'guard:g-3',
      'guard:g-2',
      'guard:g-1',
    ]);
    expect(
      (
        await t.analytics.timeline('shop-a1b2c3d4', { kinds: ['guard'], errorsOnly: true })
      ).items.map((i) => i.id),
    ).toEqual(['guard:g-1']);
    expect(
      (await t.analytics.timeline('shop-a1b2c3d4', { kinds: ['guard'], q: 'invite' })).items.map(
        (i) => i.id,
      ),
    ).toEqual(['guard:g-3']);
  });
  it('pages guard rows with ties on ts and filters q in SQL before the limit (review M7)', async () => {
    const hit = (eventId: string, ts: number, guardId = 'logout') => ({
      eventId,
      sessionId: 'shop-a1b2c3d4',
      templateId: 'tp-aaaaaaaaaa',
      packId: 'site-a.test',
      guardId,
      guardKind: 'logout' as const,
      action: 'block' as const,
      outcome: null,
      decidedBy: null,
      source: 'request' as const,
      method: 'POST',
      url: `https://www.site-a.test/${guardId}`,
      requestId: null,
      tool: null,
      ts,
    });
    // Two rows share the ts at the page boundary.
    await t.repos.siteGuardHits.insert(hit('g-a', 2_000));
    await t.repos.siteGuardHits.insert(hit('g-b', 2_000));
    await t.repos.siteGuardHits.insert(hit('g-c', 3_000));
    const ids: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await t.analytics.timeline('shop-a1b2c3d4', {
        kinds: ['guard'],
        limit: 2,
        ...(cursor != null && { cursor }),
      });
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(ids).toEqual(['guard:g-c', 'guard:g-b', 'guard:g-a']);
    // `q` finds an old row behind newer non-matching ones even with a small limit.
    for (let i = 0; i < 5; i += 1) await t.repos.siteGuardHits.insert(hit(`g-n${i}`, 4_000 + i));
    await t.repos.siteGuardHits.insert(hit('g-inv', 1_000, 'invite'));
    const found = await t.analytics.timeline('shop-a1b2c3d4', {
      kinds: ['guard'],
      q: 'invite',
      limit: 2,
    });
    expect(found.items.map((i) => i.id)).toEqual(['guard:g-inv']);
    expect(found.nextCursor).toBeNull();
  });
});

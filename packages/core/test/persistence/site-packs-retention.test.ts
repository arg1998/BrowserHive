/** @module test/persistence/site-packs-retention.test — retention of the site-pack tables (spec 13 §11.10): `site_pack_state` is configuration and never pruned; `site_pack_changes` and `site_guard_hits` are audit, pruned by `auditRetentionDays` and never byte-pruned; a pruned session leaves its guard hits with `session_id` NULL. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqliteMaintenanceService } from '../../src/infra/persistence/maintenance.ts';
import type { RetentionPolicy } from '../../src/ports/persistence/maintenance.ts';
import {
  emptySitePackState,
  type SiteGuardHitRecord,
  type SitePackChangeRecord,
} from '../../src/ports/persistence/site-packs.ts';
import { sessionRecord } from './helpers.ts';
import { openMemory, type TestDb } from './setup.ts';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const policy: RetentionPolicy = {
  retentionDays: 7,
  retentionBytes: 1024 * 1024 * 1024,
  auditRetentionDays: 90,
};

function change(eventId: string, createdAt: number, decision: SitePackChangeRecord['decision']) {
  return {
    seq: 0,
    eventId,
    packId: 'linkedin',
    fromVersion: null,
    toVersion: 1,
    toSha256: 'a'.repeat(64),
    source: 'bundled',
    classification: 'new_pack',
    newDomains: [],
    notes: null,
    diff: [],
    decision,
    decidedBy: null,
    createdAt,
    decidedAt: null,
  } satisfies SitePackChangeRecord;
}

function hit(eventId: string, ts: number, sessionId: string | null): SiteGuardHitRecord {
  return {
    eventId,
    sessionId,
    templateId: null,
    packId: 'linkedin',
    guardId: 'logout',
    guardKind: 'logout',
    action: 'block',
    outcome: null,
    decidedBy: null,
    source: 'request',
    method: 'GET',
    url: 'https://www.linkedin.com/m/logout',
    requestId: null,
    tool: null,
    ts,
  };
}

let t: TestDb;
let maintenance: SqliteMaintenanceService;
beforeEach(async () => {
  t = await openMemory();
  t.clock.set(NOW);
  maintenance = new SqliteMaintenanceService({
    handle: t.handle,
    clock: t.clock,
    logger: t.logger,
    appVersion: 'test',
  });
});
afterEach(async () => {
  await t.close();
});

describe('site-pack retention', () => {
  it('prunes audit rows past auditRetentionDays, keeps pending candidates and every state row', async () => {
    const r = t.repos;
    const ancient = NOW - 100 * DAY;
    await r.sitePackState.put(emptySitePackState('linkedin', ancient));
    await r.sitePackChanges.insert(change('c-old-decided', ancient, 'approved'));
    await r.sitePackChanges.insert(change('c-old-pending', ancient, 'available'));
    await r.sitePackChanges.insert(change('c-new', NOW - DAY, 'auto'));
    await r.siteGuardHits.insert(hit('h-old', ancient, null));
    await r.siteGuardHits.insert(hit('h-new', NOW - 30 * DAY, null));

    const result = await maintenance.retentionSweep(policy);
    expect(result.failures).toEqual([]);
    expect(result.prunedRows['site_pack_changes']).toBe(1);
    expect(result.prunedRows['site_guard_hits']).toBe(1);
    expect(await r.sitePackState.get('linkedin')).not.toBeNull();
    const changes = await r.sitePackChanges.list({});
    expect(changes.items.map((c) => c.eventId).sort()).toEqual(['c-new', 'c-old-pending']);
    expect((await r.siteGuardHits.list({})).items.map((h) => h.eventId)).toEqual(['h-new']);
  });

  it('never byte-prunes the audit tables', async () => {
    const r = t.repos;
    await r.sitePackChanges.insert(change('c-1', NOW - 30 * DAY, 'approved'));
    await r.siteGuardHits.insert(hit('h-1', NOW - 30 * DAY, null));
    const result = await maintenance.retentionSweep({ ...policy, retentionBytes: 1 });
    expect(result.prunedRows['site_pack_changes'] ?? 0).toBe(0);
    expect(result.prunedRows['site_guard_hits'] ?? 0).toBe(0);
    expect((await r.sitePackChanges.list({})).items).toHaveLength(1);
    expect((await r.siteGuardHits.list({})).items).toHaveLength(1);
  });

  it('keeps a pruned session’s guard hits with session_id NULL', async () => {
    const r = t.repos;
    const old = NOW - 10 * DAY;
    await r.sessions.insert(
      sessionRecord({
        sessionId: 'old-00000001',
        createdAt: old,
        closedAt: old + 1,
        closedReason: 'user',
        state: 'closed',
        lastActivityAt: old,
      }),
    );
    await r.sessions.insert(sessionRecord({ sessionId: 'new-00000001', createdAt: NOW - DAY }));
    await r.siteGuardHits.insert(hit('h-old-session', old, 'old-00000001'));
    await r.siteGuardHits.insert(hit('h-live-session', NOW - DAY, 'new-00000001'));

    const result = await maintenance.retentionSweep(policy);
    expect(result.prunedRows['sessions']).toBe(1);
    expect(await r.sessions.get('old-00000001')).toBeNull();
    const hits = (await r.siteGuardHits.list({})).items;
    expect(hits.map((h) => [h.eventId, h.sessionId])).toEqual([
      ['h-live-session', 'new-00000001'],
      ['h-old-session', null],
    ]);
    expect((await r.siteGuardHits.list({ sessionId: 'new-00000001' })).items).toHaveLength(1);
  });

  it('the foreign key alone also detaches the hits when a session row is deleted', async () => {
    await t.repos.sessions.insert(sessionRecord({ sessionId: 'gone-0000001' }));
    await t.repos.siteGuardHits.insert(hit('h-1', NOW, 'gone-0000001'));
    t.handle.raw.query("DELETE FROM sessions WHERE session_id = 'gone-0000001'").run();
    expect((await t.repos.siteGuardHits.list({})).items[0]?.sessionId).toBeNull();
  });
});

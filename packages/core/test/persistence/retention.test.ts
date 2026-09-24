/** @module test/persistence/retention.test — retention classes, byte cap and per-item isolation with a fake clock. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqliteMaintenanceService } from '../../src/infra/persistence/maintenance.ts';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import type { RetentionPolicy } from '../../src/ports/persistence/maintenance.ts';
import {
  blockedRequestRecord,
  pageRecord,
  screenshotRecord,
  sessionRecord,
  toolCallRecord,
  vaultAccessRecord,
} from './helpers.ts';
import { openMemory, type TestDb } from './setup.ts';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const policy: RetentionPolicy = {
  retentionDays: 7,
  retentionBytes: 1024 * 1024 * 1024,
  auditRetentionDays: 90,
};

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

async function seed(): Promise<void> {
  const old = NOW - 10 * DAY;
  const fresh = NOW - 1 * DAY;
  const r = t.repos;
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
  await r.sessions.insert(
    sessionRecord({
      sessionId: 'arch-0000001',
      createdAt: old,
      closedAt: old + 1,
      closedReason: 'user',
      state: 'closed',
      archivedAt: old + 2,
    }),
  );
  await r.sessions.insert(sessionRecord({ sessionId: 'new-00000001', createdAt: fresh }));
  await r.toolCalls.insert(
    toolCallRecord({ eventId: 'tc-old', sessionId: 'old-00000001', ts: old }),
  );
  await r.screenshots.insert(
    screenshotRecord({
      eventId: 'tc-old',
      sessionId: 'old-00000001',
      path: 'sessions/old-00000001/screenshots/tc-old.jpg',
      ts: old,
    }),
  );
  await r.toolCalls.insert(
    toolCallRecord({ eventId: 'tc-new', sessionId: 'new-00000001', ts: fresh, seq: 2 }),
  );
  await r.pages.insert(pageRecord({ eventId: 'p-old', sessionId: 'old-00000001', ts: old }));
  await r.pages.insert(pageRecord({ eventId: 'p-new', sessionId: 'new-00000001', ts: fresh }));
  await r.vaultAudit.insert(
    vaultAccessRecord({ eventId: 'v-old', sessionId: 'old-00000001', ts: old }),
  );
  await r.vaultAudit.insert(
    vaultAccessRecord({ eventId: 'v-ancient', sessionId: 'arch-0000001', ts: NOW - 100 * DAY }),
  );
  await r.blocklistAudit.insert(
    blockedRequestRecord({ eventId: 'b-ancient', sessionId: null, ts: NOW - 100 * DAY }),
  );
  await r.events.append({
    eventId: 'ev-old',
    type: 'x',
    sessionId: 'old-00000001',
    tenantId: null,
    actorKind: 'system',
    actorId: null,
    occurredAt: old,
    traceId: null,
    payload: {},
  });
  await r.operatorRequests.insert({
    requestId: 'a-old',
    kind: 'attention',
    sessionId: 'old-00000001',
    owner: 'o',
    reason: 'r',
    mode: 'notify',
    entryName: null,
    tool: null,
    toolEventId: null,
    pageUrl: null,
    options: null,
    idempotencyKey: null,
    createdAt: NOW - 100 * DAY,
    deadlineAt: null,
  });
  await r.operatorRequests.resolve('a-old', { status: 'timeout', at: NOW - 99 * DAY });
  await r.operatorRequests.insert({
    requestId: 'a-pending',
    kind: 'attention',
    sessionId: 'new-00000001',
    owner: 'o',
    reason: 'r',
    mode: 'notify',
    entryName: null,
    tool: null,
    toolEventId: null,
    pageUrl: null,
    options: null,
    idempotencyKey: null,
    createdAt: NOW - 100 * DAY,
    deadlineAt: null,
  });
  await r.notifications.insert({
    notificationId: 'n-read',
    principalId: null,
    type: 'system',
    title: 't',
    body: null,
    sessionId: null,
    target: null,
    sourceEventId: null,
    createdAt: NOW - 40 * DAY,
    updatedAt: NOW - 40 * DAY,
    count: 1,
    groupKey: null,
    readAt: NOW - 31 * DAY,
    dismissedAt: null,
  });
  await r.notifications.insert({
    notificationId: 'n-stale',
    principalId: null,
    type: 'system',
    title: 't',
    body: null,
    sessionId: null,
    target: null,
    sourceEventId: null,
    createdAt: NOW - 91 * DAY,
    updatedAt: NOW - 91 * DAY,
    count: 1,
    groupKey: null,
    readAt: null,
    dismissedAt: null,
  });
  await r.notifications.insert({
    notificationId: 'n-keep',
    principalId: null,
    type: 'system',
    title: 't',
    body: null,
    sessionId: null,
    target: null,
    sourceEventId: null,
    createdAt: NOW - 89 * DAY,
    updatedAt: NOW - 89 * DAY,
    count: 1,
    groupKey: null,
    readAt: null,
    dismissedAt: null,
  });
}

describe('retentionSweep', () => {
  it('prunes each class by its own rule and enqueues artifacts', async () => {
    await seed();
    const result = await maintenance.retentionSweep(policy);
    expect(result.failures).toEqual([]);
    expect(result.prunedRows).toMatchObject({
      screenshots: 1,
      tool_calls: 1,
      pages: 1,
      events: 1,
      vault_access: 1,
      blocked_requests: 1,
      operator_requests: 1,
      sessions: 0,
      notifications: 2,
    });
    expect(result.artifactsEnqueued).toBe(1);
    const r = t.repos;
    expect(await r.toolCalls.get('tc-new')).not.toBeNull();
    expect(await r.toolCalls.get('tc-old')).toBeNull();
    expect((await r.pages.list({})).items.map((p) => p.eventId)).toEqual(['p-new']);
    // Audit rows inside 90 days survive even when older than the telemetry window.
    expect((await r.vaultAudit.list({})).items.map((v) => v.eventId)).toEqual(['v-old']);
    expect((await r.blocklistAudit.list({})).items.length).toBe(0);
    expect(await r.operatorRequests.get('a-pending')).not.toBeNull();
    expect(await r.operatorRequests.get('a-old')).toBeNull();
    // The old session still has an audit child (v-old), so it stays; the archived one is exempt.
    expect(await r.sessions.get('old-00000001')).not.toBeNull();
    expect(await r.sessions.get('arch-0000001')).not.toBeNull();
    expect(
      (await r.notifications.list({ principalId: null })).items.map((n) => n.notificationId),
    ).toEqual(['n-keep']);
    const outbox = await r.artifactOutbox.pending(10);
    expect(outbox.map((a) => [a.kind, a.path])).toEqual([
      ['screenshot', 'sessions/old-00000001/screenshots/tc-old.jpg'],
    ]);
    expect(result.bytesAfter).toBeGreaterThan(0);
  });

  it('deletes a closed session once every child is gone, and never an archived one', async () => {
    await seed();
    await maintenance.retentionSweep({ ...policy, auditRetentionDays: 1 });
    const second = await maintenance.retentionSweep({ ...policy, auditRetentionDays: 1 });
    void second;
    expect(await t.repos.sessions.get('old-00000001')).toBeNull();
    expect(await t.repos.sessions.get('arch-0000001')).not.toBeNull();
    expect(
      (await t.repos.artifactOutbox.pending(10)).some((a) => a.path === 'sessions/old-00000001'),
    ).toBe(true);
  });

  it('prunes closed MCP connections past the window unless a session still points at them', async () => {
    const old = NOW - 10 * DAY;
    const connection = (connectionId: string, closedAt: number | null) =>
      t.repos.mcpConnections.insert({
        connectionId,
        principalId: 'local',
        transport: 'http',
        mcpSessionId: null,
        clientName: 'claude-code',
        clientVersion: '2.0.0',
        protocolVersion: null,
        capabilities: null,
        agentName: null,
        model: null,
        harness: null,
        clientTitle: null,
        workspace: null,
        modelSource: null,
        harnessSource: null,
        conflicts: [],
        meta: {},
        ip: null,
        userAgent: null,
        connectedAt: old,
        lastSeenAt: closedAt ?? NOW,
        closedAt,
      });
    await connection('c-gone', old);
    await connection('c-referenced', old);
    await connection('c-open', null);
    await connection('c-fresh', NOW - DAY);
    await t.repos.sessions.insert(
      sessionRecord({
        sessionId: 'arch-0000002',
        connectionId: 'c-referenced',
        createdAt: old,
        closedAt: old + 1,
        closedReason: 'user',
        state: 'closed',
        archivedAt: old + 2,
      }),
    );
    const result = await maintenance.retentionSweep(policy);
    expect(result.failures).toEqual([]);
    expect(result.prunedRows['mcp_connections']).toBe(1);
    const left = t.handle.raw
      .query('SELECT connection_id FROM mcp_connections ORDER BY connection_id')
      .all() as { connection_id: string }[];
    expect(left.map((row) => row.connection_id)).toEqual(['c-fresh', 'c-open', 'c-referenced']);
  });

  it('enforces the byte cap by pruning progressively older telemetry', async () => {
    for (let i = 0; i < 300; i++) {
      await t.repos.toolCalls.insert(
        toolCallRecord({
          eventId: `tc-${i}`,
          sessionId: null,
          ts: NOW - (300 - i) * 60_000,
          seq: i,
          resultText: 'x'.repeat(2_000),
        }),
      );
    }
    const before = await t.analytics.databaseSize();
    const result = await maintenance.retentionSweep({ ...policy, retentionBytes: 64 * 1024 });
    expect(result.failures).toEqual([]);
    expect(result.prunedRows['tool_calls'] ?? 0).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(before);
  });

  it('isolates a failing step and never throws', async () => {
    await seed();
    t.handle.raw.exec('DROP TABLE logs');
    const result = await maintenance.retentionSweep(policy);
    expect(result.failures.map((f) => f.step)).toEqual(['logs']);
    expect(result.prunedRows['tool_calls']).toBe(1);
    expect(t.logger.records.some((r) => r.msg === 'retention step failed')).toBe(true);
  });
});

describe('MaintenanceService', () => {
  it('reports inventory and integrity', async () => {
    await seed();
    const inventory = await maintenance.inventory();
    expect(inventory.schemaVersion).toBe(SCHEMA_VERSION);
    expect(inventory.tables.find((x) => x.table === 'sessions')?.rows).toBe(3);
    expect(await maintenance.integrityCheck()).toEqual({ ok: true, messages: ['ok'] });
    expect((await maintenance.migrate()).applied).toEqual([]);
  });
});

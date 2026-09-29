/** @module test/persistence/conformance-reports.test — the report queries (spec 03 §7.2, §9.7): `windowStats`, `countByResult` on SQLite and their in-memory doubles; `windowCounts`, `toolLatency` (the same p95 as `toolMetrics`), `topErrors` on SQLite and the in-memory analytics fake; the report facts gathered over a real database. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createReportFacts } from '../../src/app/notifications/report-facts.ts';
import type { OperatorRequestRepository } from '../../src/ports/persistence/operator-requests.ts';
import type { NewOperatorRequest } from '../../src/ports/persistence/records.ts';
import type { VaultAuditRepository } from '../../src/ports/persistence/vault-audit.ts';
import { FakeAnalytics } from '../helpers/http-fakes.ts';
import { InMemoryRepositories } from '../helpers/in-memory-repos.ts';
import { createVaultRepos } from '../helpers/in-memory-vault-repos.ts';
import {
  blockedRequestRecord,
  sessionRecord,
  toolCallRecord,
  vaultAccessRecord,
} from './helpers.ts';
import { openMemory, type TestDb } from './setup.ts';

const WINDOW = { since: 1_000, until: 2_000 };

function request(id: string, createdAt: number): NewOperatorRequest {
  return {
    requestId: id,
    kind: 'attention',
    sessionId: 'shop-a1b2c3d4',
    owner: 'local',
    reason: 'captcha',
    mode: 'takeover',
    entryName: null,
    tool: 'navigate',
    toolEventId: null,
    pageUrl: 'https://x/',
    options: null,
    idempotencyKey: null,
    createdAt,
    deadlineAt: null,
  };
}

async function seedRequests(repo: OperatorRequestRepository): Promise<void> {
  await repo.insert(request('a-000000000001', 900)); // before the window
  await repo.insert(request('a-000000000002', 1_000));
  await repo.insert(request('a-000000000003', 1_100));
  await repo.insert(request('a-000000000004', 1_200));
  await repo.insert(request('a-000000000005', 1_300));
  await repo.insert(request('a-000000000006', 1_400)); // stays pending
  await repo.insert(request('a-000000000007', 2_000)); // at `until`: outside
  await repo.resolve('a-000000000001', { status: 'resolved', at: 950 });
  await repo.resolve('a-000000000002', { status: 'resolved', at: 1_060 }); // waited 60
  await repo.resolve('a-000000000003', { status: 'rejected', at: 1_200 }); // waited 100
  await repo.resolve('a-000000000004', { status: 'resolved', at: 1_500 }); // waited 300
  await repo.resolve('a-000000000005', { status: 'timeout', at: 1_900 });
}

const EXPECTED_STATS = {
  created: 5,
  resolved: 2,
  rejected: 1,
  timedOut: 1,
  cancelled: 0,
  pending: 1,
  medianWaitMs: 100,
};

async function seedVault(repo: VaultAuditRepository): Promise<void> {
  const rows = [
    ['v1', 1_000, 'success'],
    ['v2', 1_500, 'success'],
    ['v3', 1_600, 'origin_mismatch'],
    ['v4', 2_000, 'denied'], // at `until`: outside
    ['v5', 999, 'denied'], // before
  ] as const;
  for (const [eventId, ts, result] of rows) {
    await repo.insert(vaultAccessRecord({ eventId, ts, result }));
  }
}

const EXPECTED_VAULT = [
  { result: 'success', count: 2 },
  { result: 'origin_mismatch', count: 1 },
];

describe('OperatorRequestRepository.windowStats', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await openMemory();
    await t.repos.sessions.insert(sessionRecord());
  });
  afterEach(async () => {
    await t.close();
  });

  it('counts outcomes of the requests created in [since, until) on SQLite', async () => {
    await seedRequests(t.repos.operatorRequests);
    expect(await t.repos.operatorRequests.windowStats('attention', WINDOW)).toEqual(EXPECTED_STATS);
    expect(await t.repos.operatorRequests.windowStats('vault_confirm', WINDOW)).toMatchObject({
      created: 0,
      medianWaitMs: null,
    });
  });

  it('matches the in-memory double', async () => {
    const repo = createVaultRepos().requests;
    await seedRequests(repo);
    expect(await repo.windowStats('attention', WINDOW)).toEqual(EXPECTED_STATS);
  });
});

describe('VaultAuditRepository.countByResult', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await openMemory();
    await t.repos.sessions.insert(sessionRecord());
  });
  afterEach(async () => {
    await t.close();
  });

  it('counts accesses by result in [since, until), most first, on SQLite', async () => {
    await seedVault(t.repos.vaultAudit);
    expect(await t.repos.vaultAudit.countByResult(WINDOW)).toEqual(EXPECTED_VAULT);
  });

  it('matches both in-memory doubles', async () => {
    const vault = createVaultRepos().audit;
    await seedVault(vault);
    expect(await vault.countByResult(WINDOW)).toEqual(EXPECTED_VAULT);
    const facts = new InMemoryRepositories().vaultAudit;
    await seedVault(facts);
    expect(await facts.countByResult(WINDOW)).toEqual(EXPECTED_VAULT);
  });
});

describe('AnalyticsQueries report additions', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await openMemory();
    await t.repos.sessions.insert(sessionRecord({ createdAt: 1_500 }));
  });
  afterEach(async () => {
    await t.close();
  });

  async function seedCalls(insert: (r: ReturnType<typeof toolCallRecord>) => Promise<void>) {
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000];
    let seq = 0;
    for (const [i, ms] of durations.entries()) {
      seq += 1;
      await insert(
        toolCallRecord({
          eventId: `n-${i}`,
          seq,
          ts: 1_100 + i,
          tool: 'navigate',
          durationMs: ms,
          ...(i < 3 && { ok: false, errorCode: 'NAVIGATION_TIMEOUT', errorMessage: 'x' }),
        }),
      );
    }
    seq += 1;
    await insert(
      toolCallRecord({
        eventId: 'c-1',
        seq,
        ts: 1_200,
        tool: 'click',
        durationMs: 5,
        ok: false,
        errorCode: 'ELEMENT_NOT_FOUND',
        errorMessage: 'x',
      }),
    );
    seq += 1;
    await insert(toolCallRecord({ eventId: 'late', seq, ts: 2_000, tool: 'click', durationMs: 5 }));
  }

  it('counts one window in one statement', async () => {
    await seedCalls((r) => t.repos.toolCalls.insert(r));
    await t.repos.blocklistAudit.insert(blockedRequestRecord({ eventId: 'b-1', ts: 1_300 }));
    await t.repos.blocklistAudit.insert(blockedRequestRecord({ eventId: 'b-2', ts: 2_500 }));
    await seedVault(t.repos.vaultAudit);
    await seedRequests(t.repos.operatorRequests);
    expect(await t.analytics.windowCounts(WINDOW)).toEqual({
      sessionsStarted: 1,
      toolCalls: 11,
      errors: 4,
      blocked: 1,
      attention: 5,
      vaultAccess: 3,
    });
  });

  it('computes the p95 in the database, equal to toolMetrics', async () => {
    await seedCalls((r) => t.repos.toolCalls.insert(r));
    const latency = await t.analytics.toolLatency(WINDOW);
    const metrics = await t.analytics.toolMetrics({
      ...WINDOW,
      until: WINDOW.until - 1,
      groupBy: 'tool',
    });
    expect(latency).toEqual([
      { tool: 'navigate', calls: 10, errors: 3, p95Ms: 1000 },
      { tool: 'click', calls: 1, errors: 1, p95Ms: 5 },
    ]);
    for (const row of latency) {
      expect(metrics.find((m) => m.tool === row.tool)?.p95Ms).toBe(row.p95Ms);
    }
  });

  it('lists the top errors with their sessions', async () => {
    await seedCalls((r) => t.repos.toolCalls.insert(r));
    expect(await t.analytics.topErrors(WINDOW, 5)).toEqual([
      { errorCode: 'NAVIGATION_TIMEOUT', tool: 'navigate', count: 3, sessions: 1 },
      { errorCode: 'ELEMENT_NOT_FOUND', tool: 'click', count: 1, sessions: 1 },
    ]);
  });

  it('matches the in-memory analytics fake', async () => {
    const repos = new InMemoryRepositories();
    await seedCalls((r) => repos.toolCalls.insert(r));
    await seedCalls((r) => t.repos.toolCalls.insert(r));
    const fake = new FakeAnalytics(repos);
    const sqlite = await t.analytics.toolLatency(WINDOW);
    const memory = await fake.toolLatency(WINDOW);
    expect([...memory].sort((a, b) => a.tool.localeCompare(b.tool))).toEqual(
      [...sqlite].sort((a, b) => a.tool.localeCompare(b.tool)),
    );
    expect(await fake.topErrors(WINDOW, 5)).toEqual(await t.analytics.topErrors(WINDOW, 5));
  });

  it('gathers a digest and the anomaly facts over a real database', async () => {
    await seedCalls((r) => t.repos.toolCalls.insert(r));
    await seedVault(t.repos.vaultAudit);
    await seedRequests(t.repos.operatorRequests);
    const facts = createReportFacts({
      analytics: t.analytics,
      repos: t.repos,
      capacity: () => ({ live: 1, max: 4 }),
    });
    const digest = await facts.digest(WINDOW, { every: 'day', at: '09:00' });
    expect(digest).toMatchObject({
      sessionsStarted: 1,
      sessionsLive: 1,
      toolCalls: 11,
      errors: 4,
      // Waiting now counts every pending request, also one created after the window.
      attention: { ...EXPECTED_STATS, pending: 2 },
      vault: EXPECTED_VAULT,
      slowest: { tool: 'navigate', p95Ms: 1000, previousP95Ms: null },
    });
    expect(digest.topErrors[0]?.errorCode).toBe('NAVIGATION_TIMEOUT');
    const anomaly = await facts.anomaly(2_000);
    expect(anomaly).toMatchObject({ live: 1, maxSessions: 4, toolCalls: 11, errors: 4 });
    expect(anomaly.attentionWaiting).toEqual([
      { sessionSlug: 'shop', waitedMs: 600 },
      { sessionSlug: 'shop', waitedMs: 0 },
    ]);
  });
});

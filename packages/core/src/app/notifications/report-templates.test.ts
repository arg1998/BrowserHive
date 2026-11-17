/** @module app/notifications/report-templates.test — the digests' "Templates" block (spec 13 §8.6, D-43): facts from the probes and versions of the window (distinct signed-out sites, `relogin` versions, challenged probes), the block at every content level, omitted when all are 0 or templates are off, and a digest that is not empty because of it. */

import { describe, expect, it } from 'bun:test';
import type { DigestRule } from '@browserhive/contracts/notifications';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import type { TemplateProbeRecord } from '../../ports/persistence/records-templates.ts';
import { createReportFacts } from './report-facts.ts';
import {
  hasTemplateNews,
  type TemplateDigestFacts,
  templateDigestBlocks,
  templateDigestFacts,
} from './report-templates.ts';
import { buildDigest, type DigestFacts, isEmptyDigest, type ReportContext } from './reports.ts';
import { sampleDigestFacts } from './samples.ts';

const HOUR = 3_600_000;
const UNTIL = Date.UTC(2026, 10, 16, 8);
const WINDOW = { since: UNTIL - 24 * HOUR, until: UNTIL };
const DAILY: DigestRule = { every: 'day', at: '09:00' };

function probe(overrides: Partial<TemplateProbeRecord>): TemplateProbeRecord {
  return {
    seq: 0,
    templateId: 'tp-aaaaaaaaaa',
    siteId: 'site-a.test',
    outcome: 'signed_in',
    reason: 'cookies_present',
    trigger: 'schedule',
    finalUrl: null,
    durationMs: 5,
    at: WINDOW.since + HOUR,
    ...overrides,
  };
}

async function seeded(): Promise<InMemoryRepositories> {
  const repos = new InMemoryRepositories();
  const rows: Partial<TemplateProbeRecord>[] = [
    { outcome: 'signed_out' },
    { outcome: 'signed_out', at: WINDOW.since + 2 * HOUR },
    { outcome: 'signed_out', siteId: 'site-b.test' },
    { outcome: 'signed_out', templateId: 'tp-bbbbbbbbbb' },
    { outcome: 'signed_out', at: WINDOW.since - 1 },
    { outcome: 'signed_out', at: WINDOW.until },
    { outcome: 'challenged' },
    { outcome: 'challenged', siteId: 'site-b.test' },
    { outcome: 'inconclusive' },
  ];
  for (const row of rows) await repos.templateProbes.insert(probe(row));
  const version = (n: number, reason: 'relogin' | 'checkpoint' | 'manual', createdAt: number) =>
    repos.templateVersions.insert({
      templateId: 'tp-aaaaaaaaaa',
      version: n,
      reason,
      restoredFrom: null,
      pinned: false,
      summary: { domains: [] },
      health: [],
      file: { path: `v${n}.bhte`, sizeBytes: 1, keyId: 'k' },
      createdBy: null,
      createdAt,
    } as never);
  await version(1, 'relogin', WINDOW.since + HOUR);
  await version(2, 'relogin', WINDOW.since + 3 * HOUR);
  await version(3, 'manual', WINDOW.since + 4 * HOUR);
  await version(4, 'relogin', WINDOW.since - HOUR);
  return repos;
}

function ctx(level: ReportContext['level']): ReportContext {
  return {
    zone: 'UTC',
    level,
    scheduledAt: UNTIL,
    late: false,
    skipped: 0,
    manual: false,
    quiet: false,
  };
}

describe('templateDigestFacts', () => {
  it('counts distinct signed-out sites, relogin versions and challenged probes in [since, until)', async () => {
    expect(await templateDigestFacts(await seeded(), WINDOW)).toEqual({
      signedOut: 3,
      relogins: 2,
      challenges: 2,
    });
    expect(
      await templateDigestFacts(await seeded(), { since: UNTIL + HOUR, until: UNTIL + 2 * HOUR }),
    ).toEqual({ signedOut: 0, relogins: 0, challenges: 0 });
  });

  it('createReportFacts gathers them only with templates on', async () => {
    const seededRepos = await seeded();
    const repos = {
      operatorRequests: {
        windowStats: async () => ({
          created: 0,
          resolved: 0,
          rejected: 0,
          timedOut: 0,
          cancelled: 0,
          medianWaitMs: null,
        }),
        countOpen: async () => 0,
      },
      vaultAudit: { countByResult: async () => [] },
      blocklistAudit: { stats: async () => ({ topPatterns: [], topDomains: [] }) },
      systemEvents: { open: async () => [] },
      templateProbes: seededRepos.templateProbes,
      templateVersions: seededRepos.templateVersions,
    } as never;
    const analytics = {
      windowCounts: async () => ({ sessionsStarted: 0, toolCalls: 0, errors: 0, blocked: 0 }),
      toolLatency: async () => [],
      topErrors: async () => [],
      harnessMetrics: async () => [],
      activity: async () => ({ window: { bucketMs: HOUR }, buckets: [] }),
    } as never;
    const make = (templates?: boolean) =>
      createReportFacts({
        analytics,
        repos,
        capacity: () => ({ live: 0, max: 4 }),
        ...(templates !== undefined && { templates }),
      }).digest(WINDOW, DAILY);
    expect((await make(true)).templates).toEqual({ signedOut: 3, relogins: 2, challenges: 2 });
    expect((await make(false)).templates).toBeNull();
    expect((await make()).templates).toBeNull();
  });
});

describe('the Templates block', () => {
  const some: TemplateDigestFacts = { signedOut: 2, relogins: 1, challenges: 0 };

  it('is a heading and three fields, at every content level', () => {
    for (const level of ['counts', 'titles', 'full'] as const) {
      const blocks = buildDigest(
        { ...sampleDigestFacts(UNTIL, DAILY), templates: some },
        DAILY,
        ctx(level),
      ).blocks;
      const at = blocks.findIndex((b) => b.type === 'heading' && b.text === 'Templates');
      expect(at).toBeGreaterThan(0);
      expect(blocks[at + 1]).toEqual({
        type: 'fields',
        items: [
          { label: 'Sites signed out', value: [{ type: 'text', text: '2' }] },
          { label: 'Re-logins', value: [{ type: 'text', text: '1' }] },
          { label: 'Challenges', value: [{ type: 'text', text: '0' }] },
        ],
      });
    }
  });

  it('is omitted when all are 0 and when templates are off', () => {
    const none = { signedOut: 0, relogins: 0, challenges: 0 };
    expect(templateDigestBlocks(none)).toEqual([]);
    expect(templateDigestBlocks(null)).toEqual([]);
    expect(templateDigestBlocks(undefined)).toEqual([]);
    for (const templates of [none, null]) {
      const blocks = buildDigest(
        { ...sampleDigestFacts(UNTIL, DAILY), templates },
        DAILY,
        ctx('full'),
      ).blocks;
      expect(blocks.some((b) => b.type === 'heading' && b.text === 'Templates')).toBe(false);
    }
  });

  it('a window with only template news is not an empty digest', () => {
    const quiet: DigestFacts = {
      ...sampleDigestFacts(UNTIL, DAILY),
      sessionsStarted: 0,
      toolCalls: 0,
      attention: { ...sampleDigestFacts(UNTIL, DAILY).attention, created: 0 },
      vault: [],
      blocked: { count: 0, topPattern: null, topDomain: null },
      degradations: [],
    };
    expect(isEmptyDigest({ ...quiet, templates: null })).toBe(true);
    expect(
      isEmptyDigest({ ...quiet, templates: { signedOut: 0, relogins: 0, challenges: 0 } }),
    ).toBe(true);
    expect(
      isEmptyDigest({ ...quiet, templates: { signedOut: 0, relogins: 0, challenges: 1 } }),
    ).toBe(false);
    expect(hasTemplateNews({ signedOut: 0, relogins: 1, challenges: 0 })).toBe(true);
  });
});

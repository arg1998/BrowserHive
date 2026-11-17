/** @module test/persistence/conformance-template-probes.test — `TemplateProbeRepository`: the SQLite repository and the in-memory double behave the same (spec 13 §2.6, §8; spec 09): insert returns increasing `seq`, newest first with filters and keyset paging on (`at`, `seq`), `since` oldest first within `[since, until)`, prune, and (SQLite) the cascade when the template is deleted. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { TemplateProbeRecord } from '../../src/ports/persistence/records-templates.ts';
import type {
  TemplateProbeRepository,
  TemplateRepository,
} from '../../src/ports/persistence/templates.ts';
import { InMemoryTemplateProbeRepository } from '../helpers/in-memory-probe-repo.ts';
import { TEMPLATE_ID, templateRecord } from './helpers.ts';
import { openMemory } from './setup.ts';

const OTHER = 'tp-other00001';

interface Repos {
  readonly probes: TemplateProbeRepository;
  /** `null` for the in-memory double, which is not linked to the templates table. */
  readonly templates: TemplateRepository | null;
  close(): Promise<void>;
}

const IMPLEMENTATIONS: readonly [string, () => Promise<Repos>][] = [
  [
    'sqlite',
    async () => {
      const t = await openMemory();
      await t.repos.templates.insert(templateRecord());
      await t.repos.templates.insert(templateRecord({ templateId: OTHER, name: 'other' }));
      return { probes: t.repos.templateProbes, templates: t.repos.templates, close: t.close };
    },
  ],
  [
    'in-memory',
    async () => ({
      probes: new InMemoryTemplateProbeRepository(),
      templates: null,
      close: async () => undefined,
    }),
  ],
];

function probe(overrides: Partial<TemplateProbeRecord> = {}): TemplateProbeRecord {
  return {
    seq: 0,
    templateId: TEMPLATE_ID,
    siteId: 'site-a.test',
    outcome: 'signed_in',
    reason: 'cookies_present',
    trigger: 'schedule',
    finalUrl: null,
    durationMs: 12,
    at: 1_000,
    ...overrides,
  };
}

/** Inserts `rows` in order; returns their `seq`s. */
async function insertAll(repo: TemplateProbeRepository, rows: Partial<TemplateProbeRecord>[]) {
  const seqs: number[] = [];
  for (const row of rows) seqs.push(await repo.insert(probe(row)));
  return seqs;
}

for (const [name, open] of IMPLEMENTATIONS) {
  describe(`template probe repository (${name})`, () => {
    let repos: Repos;
    afterEach(async () => repos.close());

    it('inserts with increasing seq and keeps every field', async () => {
      repos = await open();
      const [a, b] = await insertAll(repos.probes, [
        { finalUrl: 'https://site-a.test/feed', outcome: 'signed_out', reason: 'cookie_missing' },
        { trigger: 'prelaunch' },
      ]);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a ?? 0);
      const page = await repos.probes.list(TEMPLATE_ID, {});
      expect(page.items[1]).toEqual(
        probe({
          seq: a ?? 0,
          finalUrl: 'https://site-a.test/feed',
          outcome: 'signed_out',
          reason: 'cookie_missing',
        }),
      );
      expect(page.nextCursor).toBeNull();
    });

    it('lists one template newest first (at, then seq) with filters', async () => {
      repos = await open();
      await insertAll(repos.probes, [
        { at: 300 },
        { at: 100, outcome: 'signed_out' },
        { at: 200, siteId: 'site-b.test', trigger: 'manual' },
        { at: 200, outcome: 'challenged' },
        { at: 250, templateId: OTHER },
      ]);
      const ats = async (query: Parameters<TemplateProbeRepository['list']>[1]) =>
        (await repos.probes.list(TEMPLATE_ID, query)).items.map((p) => [p.at, p.siteId, p.outcome]);
      expect(await ats({})).toEqual([
        [300, 'site-a.test', 'signed_in'],
        [200, 'site-a.test', 'challenged'],
        [200, 'site-b.test', 'signed_in'],
        [100, 'site-a.test', 'signed_out'],
      ]);
      expect(await ats({ siteId: 'site-b.test' })).toEqual([[200, 'site-b.test', 'signed_in']]);
      expect(await ats({ outcomes: ['signed_out', 'challenged'] })).toEqual([
        [200, 'site-a.test', 'challenged'],
        [100, 'site-a.test', 'signed_out'],
      ]);
      expect(await ats({ triggers: ['manual'] })).toEqual([[200, 'site-b.test', 'signed_in']]);
      expect(await ats({ since: 200, until: 300 })).toEqual([
        [200, 'site-a.test', 'challenged'],
        [200, 'site-b.test', 'signed_in'],
      ]);
    });

    it('pages with its cursor in the same order, also when at and seq disagree', async () => {
      repos = await open();
      await insertAll(repos.probes, [{ at: 300 }, { at: 100 }, { at: 200 }, { at: 200 }]);
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await repos.probes.list(TEMPLATE_ID, {
          limit: 1,
          ...(cursor !== null && { cursor }),
        });
        seen.push(...result.items.map((p) => p.at));
        cursor = result.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual([300, 200, 200, 100]);
    });

    it('since: every template within [since, until), oldest first', async () => {
      repos = await open();
      await insertAll(repos.probes, [
        { at: 500 },
        { at: 100 },
        { at: 300, templateId: OTHER },
        { at: 200 },
        { at: 600 },
      ]);
      const rows = await repos.probes.since(100, 600);
      expect(rows.map((p) => [p.at, p.templateId])).toEqual([
        [100, TEMPLATE_ID],
        [200, TEMPLATE_ID],
        [300, OTHER],
        [500, TEMPLATE_ID],
      ]);
      expect(await repos.probes.since(700, 800)).toEqual([]);
    });

    it('prunes rows older than the cutoff and reports how many', async () => {
      repos = await open();
      await insertAll(repos.probes, [{ at: 100 }, { at: 200 }, { at: 300, templateId: OTHER }]);
      expect(await repos.probes.prune(250)).toBe(2);
      expect(await repos.probes.prune(250)).toBe(0);
      expect((await repos.probes.since(0, 1_000)).map((p) => p.at)).toEqual([300]);
    });
  });
}

describe('template probe repository (sqlite): cascade', () => {
  it("a deleted template's probes go with it", async () => {
    const repos = await IMPLEMENTATIONS[0]?.[1]();
    if (repos === undefined || repos.templates === null) throw new Error('no sqlite');
    try {
      await insertAll(repos.probes, [{ at: 100 }, { at: 200, templateId: OTHER }]);
      expect(await repos.templates.remove(TEMPLATE_ID)).toBe(true);
      expect((await repos.probes.list(TEMPLATE_ID, {})).items).toEqual([]);
      expect((await repos.probes.since(0, 1_000)).map((p) => p.templateId)).toEqual([OTHER]);
    } finally {
      await repos.close();
    }
  });
});

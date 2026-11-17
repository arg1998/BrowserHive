/** @module test/persistence/conformance-site-packs.test — the site-pack repositories (spec 13 §9.9): SQLite and the in-memory doubles behave the same: state put/get/list with every provenance shape, candidates with `seq`, decisions, pending and paged history, guard hits with filters, keyset paging and per-template counts, and audit pruning (pending candidates kept). */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Page } from '../../src/ports/persistence/queries.ts';
import {
  emptySitePackState,
  type SiteGuardHitRecord,
  type SiteGuardHitRepository,
  type SitePackChangeRecord,
  type SitePackChangeRepository,
  type SitePackStateRecord,
  type SitePackStateRepository,
} from '../../src/ports/persistence/site-packs.ts';
import {
  InMemorySiteGuardHitRepository,
  InMemorySitePackChangeRepository,
  InMemorySitePackStateRepository,
} from '../helpers/in-memory-site-pack-repos.ts';
import { openMemory } from './setup.ts';

interface Repos {
  readonly state: SitePackStateRepository;
  readonly changes: SitePackChangeRepository;
  readonly hits: SiteGuardHitRepository;
  close(): Promise<void>;
}

const IMPLEMENTATIONS: readonly [string, () => Promise<Repos>][] = [
  [
    'sqlite',
    async () => {
      const t = await openMemory();
      return {
        state: t.repos.sitePackState,
        changes: t.repos.sitePackChanges,
        hits: t.repos.siteGuardHits,
        close: t.close,
      };
    },
  ],
  [
    'in-memory',
    async () => ({
      state: new InMemorySitePackStateRepository(),
      changes: new InMemorySitePackChangeRepository(),
      hits: new InMemorySiteGuardHitRepository(),
      close: async () => undefined,
    }),
  ],
];

function change(overrides: Partial<SitePackChangeRecord> = {}): SitePackChangeRecord {
  return {
    seq: 0,
    eventId: 'e-change-1',
    packId: 'linkedin',
    fromVersion: null,
    toVersion: 3,
    toSha256: 'a'.repeat(64),
    source: 'bundled',
    classification: 'new_pack',
    newDomains: ['linkedin.com'],
    notes: null,
    diff: [{ path: 'guards[0].action', from: 'warn', to: 'block', class: null }],
    decision: 'available',
    decidedBy: null,
    createdAt: 1_000,
    decidedAt: null,
    ...overrides,
  };
}

function hit(overrides: Partial<SiteGuardHitRecord> = {}): SiteGuardHitRecord {
  return {
    eventId: 'e-hit-1',
    sessionId: null,
    templateId: 'tp-fixture001',
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
    ts: 1_000,
    ...overrides,
  };
}

/** Follows `nextCursor` until the last page; returns every item in order. */
async function drain<T>(fetch: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page: Page<T> = await fetch(cursor);
    out.push(...page.items);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
  throw new Error('paging did not terminate');
}

for (const [name, open] of IMPLEMENTATIONS) {
  describe(`site-pack repositories (${name})`, () => {
    let repos: Repos;
    afterEach(async () => repos.close());

    it('puts, replaces and lists state rows with every provenance shape', async () => {
      repos = await open();
      expect(await repos.state.get('linkedin')).toBeNull();
      const fresh = emptySitePackState('zillow', 5);
      await repos.state.put(fresh);
      expect(await repos.state.get('zillow')).toEqual(fresh);
      const provenances: SitePackStateRecord['approvedProvenance'][] = [
        { kind: 'bundled', release: '0.4.0' },
        { kind: 'remote', keyId: 'k-2026', indexVersion: 17 },
        { kind: 'import', file: 'linkedin.pack.json' },
        { kind: 'local', path: '/data/site-packs/local/linkedin.json' },
      ];
      for (const approvedProvenance of provenances) {
        const full: SitePackStateRecord = {
          packId: 'linkedin',
          approvedVersion: 3,
          approvedSha256: 'b'.repeat(64),
          approvedSource: 'bundled',
          approvedProvenance,
          approvedDomains: ['linkedin.com', 'licdn.com'],
          approvedBy: 'local',
          approvedAt: 10,
          previousVersion: 2,
          previousSha256: 'c'.repeat(64),
          previousSource: 'remote',
          localPath: '/data/site-packs/local/linkedin.json',
          localApprovedSha256: 'd'.repeat(64),
          localApprovedBy: 'local',
          localApprovedAt: 11,
          pinnedVersion: 3,
          follow: false,
          enabled: false,
          updatedAt: 12,
        };
        await repos.state.put(full);
        expect(await repos.state.get('linkedin')).toEqual(full);
      }
      await repos.state.put({ ...fresh, follow: true, updatedAt: 6 });
      expect((await repos.state.get('zillow'))?.follow).toBe(true);
      expect((await repos.state.list()).map((s) => s.packId)).toEqual(['linkedin', 'zillow']);
    });

    it('inserts candidates with increasing seq, decides them and finds the newest candidate', async () => {
      repos = await open();
      const a = await repos.changes.insert(change());
      expect(a.seq).toBeGreaterThan(0);
      expect(a).toEqual(change({ seq: a.seq }));
      const b = await repos.changes.insert(
        change({
          eventId: 'e-change-2',
          source: 'local',
          toVersion: null,
          classification: 'local_override',
          diff: null,
          newDomains: [],
          notes: 'edited',
          decision: 'downloaded',
          createdAt: 2_000,
        }),
      );
      expect(b.seq).toBeGreaterThan(a.seq);
      const c = await repos.changes.insert(change({ eventId: 'e-change-3', createdAt: 3_000 }));
      expect((await repos.changes.findCandidate('linkedin', 'a'.repeat(64), 'bundled'))?.seq).toBe(
        c.seq,
      );
      expect(await repos.changes.findCandidate('linkedin', 'a'.repeat(64), 'remote')).toBeNull();
      expect((await repos.changes.listPending()).map((r) => r.eventId)).toEqual([
        'e-change-1',
        'e-change-2',
        'e-change-3',
      ]);
      await repos.changes.decide(a.eventId, 'approved', 'local', 4_000);
      await repos.changes.decide(c.eventId, 'superseded', 'browserhive', 4_001);
      expect((await repos.changes.listPending()).map((r) => r.eventId)).toEqual(['e-change-2']);
      const decided = await repos.changes.findCandidate('linkedin', 'a'.repeat(64), 'bundled');
      expect(decided).toMatchObject({ decision: 'superseded', decidedBy: 'browserhive' });
      expect(decided?.decidedAt).toBe(4_001);
    });

    it('classifies a row in place: classification and the classified diff (spec 13 §9.7)', async () => {
      repos = await open();
      const row = await repos.changes.insert(change({ classification: 'unclassified' }));
      const diff = [
        { path: 'guards[logout]', from: { id: 'logout' }, to: null, class: 'loosening' as const },
      ];
      await repos.changes.classify(row.eventId, 'loosening', diff);
      await repos.changes.classify('e-missing', 'neutral', null);
      const [stored] = await repos.changes.listPending();
      expect(stored).toMatchObject({ eventId: row.eventId, classification: 'loosening', diff });
      expect(stored?.decision).toBe(row.decision);
    });

    it('lists history newest first with filters and keyset paging', async () => {
      repos = await open();
      for (let i = 1; i <= 7; i++) {
        await repos.changes.insert(
          change({
            eventId: `e-change-${i}`,
            packId: i % 2 === 0 ? 'zillow' : 'linkedin',
            // Two rows share each timestamp: `seq` breaks the tie.
            createdAt: Math.ceil(i / 2) * 1_000,
            decision: i === 3 ? 'rejected' : 'available',
          }),
        );
      }
      const all = await drain((cursor) => repos.changes.list({ limit: 2, cursor }));
      expect(all.map((r) => r.eventId)).toEqual([7, 6, 5, 4, 3, 2, 1].map((i) => `e-change-${i}`));
      const linkedin = await repos.changes.list({ packId: 'linkedin' });
      expect(linkedin.items.map((r) => r.eventId)).toEqual([
        'e-change-7',
        'e-change-5',
        'e-change-3',
        'e-change-1',
      ]);
      const rejected = await repos.changes.list({ decisions: ['rejected'] });
      expect(rejected.items.map((r) => r.eventId)).toEqual(['e-change-3']);
      const window = await repos.changes.list({ window: { since: 2_000, until: 4_000 } });
      expect(window.items.map((r) => r.eventId)).toEqual([
        'e-change-6',
        'e-change-5',
        'e-change-4',
        'e-change-3',
      ]);
    });

    it('prunes decided candidates before the cutoff and keeps pending ones', async () => {
      repos = await open();
      const old = await repos.changes.insert(change({ eventId: 'e-old', createdAt: 100 }));
      await repos.changes.decide(old.eventId, 'approved', 'local', 150);
      await repos.changes.insert(change({ eventId: 'e-old-pending', createdAt: 100 }));
      await repos.changes.insert(change({ eventId: 'e-new', decision: 'auto', createdAt: 900 }));
      expect(await repos.changes.pruneBefore(500)).toBe(1);
      const left = await repos.changes.list({});
      expect(left.items.map((r) => r.eventId).sort()).toEqual(['e-new', 'e-old-pending']);
    });

    it('records guard hits idempotently, filters, pages and counts per template', async () => {
      repos = await open();
      const rows = [
        hit({ eventId: 'e-hit-1', ts: 1_000 }),
        hit({ eventId: 'e-hit-2', ts: 2_000, action: 'confirm', outcome: 'approved' }),
        hit({ eventId: 'e-hit-3', ts: 2_000, templateId: null, packId: 'zillow' }),
        hit({
          eventId: 'e-hit-4',
          ts: 3_000,
          action: 'warn',
          source: 'tool',
          tool: 'click',
          method: null,
          requestId: 'req-1',
          decidedBy: 'local',
          guardKind: 'write',
        }),
        hit({ eventId: 'e-hit-5', ts: 4_000, templateId: 'tp-other00001' }),
      ];
      for (const r of rows) await repos.hits.insert(r);
      await repos.hits.insert(hit({ eventId: 'e-hit-1', url: 'https://changed.test/' }));
      const all = await drain((cursor) => repos.hits.list({ limit: 2, cursor }));
      expect(all.map((r) => r.eventId)).toEqual([
        'e-hit-5',
        'e-hit-4',
        'e-hit-3',
        'e-hit-2',
        'e-hit-1',
      ]);
      expect(all[1]).toEqual(rows[3]);
      expect(all[4]?.url).toBe('https://www.linkedin.com/m/logout');
      const byTemplate = await repos.hits.list({ templateId: 'tp-fixture001' });
      expect(byTemplate.items.map((r) => r.eventId)).toEqual(['e-hit-4', 'e-hit-2', 'e-hit-1']);
      const confirms = await repos.hits.list({ actions: ['confirm', 'warn'] });
      expect(confirms.items.map((r) => r.eventId)).toEqual(['e-hit-4', 'e-hit-2']);
      expect((await repos.hits.list({ packId: 'zillow' })).items.map((r) => r.eventId)).toEqual([
        'e-hit-3',
      ]);
      // `until` is inclusive, like every other list window (review PR #83 M7).
      const window = await repos.hits.list({ window: { since: 2_000, until: 3_000 } });
      expect(window.items.map((r) => r.eventId)).toEqual(['e-hit-4', 'e-hit-3', 'e-hit-2']);
      expect(await repos.hits.countByTemplate('tp-fixture001', 0)).toBe(3);
      expect(await repos.hits.countByTemplate('tp-fixture001', 2_000)).toBe(2);
      expect(await repos.hits.countByTemplate('tp-none', 0)).toBe(0);
      expect(await repos.hits.pruneBefore(2_500)).toBe(3);
      expect((await repos.hits.list({})).items.map((r) => r.eventId)).toEqual([
        'e-hit-5',
        'e-hit-4',
      ]);
    });
  });
}

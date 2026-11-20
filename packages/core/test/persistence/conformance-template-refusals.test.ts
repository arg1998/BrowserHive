/** @module test/persistence/conformance-template-refusals.test — `TemplateRefusalRepository` (deferred D60): the SQLite repository and the in-memory double behave the same: one row per (principal, harness, declared name, kind) with the count, first and last time and the newest reason; at most `maxRows` rows per template, the one seen longest ago dropped; nothing for a template that does not exist; newest first; and (SQLite) the rows go with a deleted template. */

import { afterEach, describe, expect, it } from 'bun:test';
import type {
  TemplateRefusalRecord,
  TemplateRefusalRepository,
} from '../../src/ports/persistence/template-refusals.ts';
import type { TemplateRepository } from '../../src/ports/persistence/templates.ts';
import { InMemoryTemplateRefusalRepository } from '../helpers/in-memory-refusal-repo.ts';
import { TEMPLATE_ID, templateRecord } from './helpers.ts';
import { openMemory } from './setup.ts';

const OTHER = 'tp-other00001';
const KNOWN = new Set([TEMPLATE_ID, OTHER]);

interface Repos {
  readonly refusals: TemplateRefusalRepository;
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
      return { refusals: t.repos.templateRefusals, templates: t.repos.templates, close: t.close };
    },
  ],
  [
    'in-memory',
    async () => ({
      refusals: new InMemoryTemplateRefusalRepository((id) => KNOWN.has(id)),
      templates: null,
      close: async () => undefined,
    }),
  ],
];

function delta(overrides: Partial<TemplateRefusalRecord> = {}): TemplateRefusalRecord {
  return {
    templateId: TEMPLATE_ID,
    principal: 'p-agent',
    harness: 'cursor',
    harnessDeclared: null,
    kind: 'list',
    reason: 'principal_not_allowed',
    count: 1,
    firstAt: 1_000,
    lastAt: 1_000,
    ...overrides,
  };
}

for (const [name, open] of IMPLEMENTATIONS) {
  describe(`template refusal repository (${name})`, () => {
    let repos: Repos;
    afterEach(async () => repos.close());

    it('aggregates one client and kind into one row', async () => {
      repos = await open();
      await repos.refusals.record(delta(), 100);
      await repos.refusals.record(
        delta({ count: 4, firstAt: 2_000, lastAt: 3_000, reason: 'harness_not_allowed' }),
        100,
      );
      expect(await repos.refusals.list(TEMPLATE_ID)).toEqual([
        delta({ count: 5, firstAt: 1_000, lastAt: 3_000, reason: 'harness_not_allowed' }),
      ]);
    });

    it('keeps principals, harnesses, declared names and kinds apart; newest first', async () => {
      repos = await open();
      await repos.refusals.record(delta({ lastAt: 1 }), 100);
      await repos.refusals.record(delta({ principal: 'p-b', lastAt: 2 }), 100);
      await repos.refusals.record(delta({ harness: 'other', lastAt: 3 }), 100);
      await repos.refusals.record(
        delta({ harness: 'other', harnessDeclared: 'Nightly', lastAt: 4 }),
        100,
      );
      await repos.refusals.record(delta({ kind: 'launch', lastAt: 5 }), 100);
      await repos.refusals.record(delta({ templateId: OTHER, lastAt: 6 }), 100);
      const rows = await repos.refusals.list(TEMPLATE_ID);
      expect(rows.map((r) => r.lastAt)).toEqual([5, 4, 3, 2, 1]);
      expect(rows[1]?.harnessDeclared).toBe('Nightly');
      expect(rows[2]?.harnessDeclared).toBe(null);
      expect((await repos.refusals.list(OTHER)).length).toBe(1);
    });

    it('keeps at most maxRows per template, dropping the one seen longest ago', async () => {
      repos = await open();
      for (let i = 0; i < 6; i++) {
        await repos.refusals.record(delta({ principal: `p-${i}`, firstAt: i, lastAt: i }), 4);
      }
      // A refusal of the oldest kept row brings it back to the front.
      await repos.refusals.record(delta({ principal: 'p-2', firstAt: 10, lastAt: 10 }), 4);
      await repos.refusals.record(delta({ templateId: OTHER, lastAt: 0 }), 4);
      const rows = await repos.refusals.list(TEMPLATE_ID);
      expect(rows.map((r) => r.principal)).toEqual(['p-2', 'p-5', 'p-4', 'p-3']);
      expect(rows[0]).toMatchObject({ count: 2, firstAt: 2, lastAt: 10 });
      expect((await repos.refusals.list(OTHER)).length).toBe(1);
    });

    it('records nothing for a template that does not exist', async () => {
      repos = await open();
      await repos.refusals.record(delta({ templateId: 'tp-missing001' }), 100);
      expect(await repos.refusals.list('tp-missing001')).toEqual([]);
    });
  });
}

describe('template refusal repository (sqlite): cascade', () => {
  it("a deleted template's refusals go with it", async () => {
    const repos = await IMPLEMENTATIONS[0]?.[1]();
    if (repos === undefined || repos.templates === null) throw new Error('no sqlite');
    try {
      await repos.refusals.record(delta(), 100);
      await repos.refusals.record(delta({ templateId: OTHER }), 100);
      expect(await repos.templates.remove(TEMPLATE_ID)).toBe(true);
      expect(await repos.refusals.list(TEMPLATE_ID)).toEqual([]);
      expect((await repos.refusals.list(OTHER)).length).toBe(1);
    } finally {
      await repos.close();
    }
  });
});

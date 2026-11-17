/** @module test/persistence/migration-ddl.test — every migration's SQL text is pinned byte for byte (`fixtures/ddl/<NNNN>-<name>.sql`; D-04, spec 13 §9.9): a shipped migration never changes, whether by an edit or by a live enum it once read. A new migration's golden is written with `UPDATE_GOLDENS=1`; an existing golden is never rewritten. */

import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS } from '../../src/infra/persistence/migrations/index.ts';

const DIR = join(import.meta.dir, 'fixtures', 'ddl');

function goldenName(version: number, name: string): string {
  return `${String(version).padStart(4, '0')}-${name}.sql`;
}

describe('migration DDL goldens', () => {
  for (const migration of MIGRATIONS) {
    const file = goldenName(migration.version, migration.name);
    it(`v${migration.version} ${migration.name} matches fixtures/ddl/${file}`, async () => {
      const golden = Bun.file(join(DIR, file));
      // Blessing only creates the golden of a new migration; a shipped one is immutable.
      if (Bun.env['UPDATE_GOLDENS'] === '1' && !(await golden.exists())) {
        await Bun.write(golden, migration.sql);
      }
      expect(await golden.exists()).toBe(true);
      expect(migration.sql).toBe(await golden.text());
    });
  }

  it('has no golden without its migration', () => {
    const expected = MIGRATIONS.map((m) => goldenName(m.version, m.name)).sort();
    expect(readdirSync(DIR).sort()).toEqual(expected);
  });
});

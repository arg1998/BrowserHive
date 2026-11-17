/** @module test/persistence/site-packs-corrupt.test — one corrupt `site_pack_state` or `site_pack_changes` cell (review #83 C-M5): without `onUnreadable` the read throws as before; with it the row is reported and left out while every other row is returned. */

import { afterEach, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import {
  emptySitePackState,
  type SitePackChangeRecord,
} from '../../src/ports/persistence/site-packs.ts';
import { openMemory, type TestDb } from './setup.ts';

let db: TestDb;
afterEach(async () => db.close());

function pending(packId: string, eventId: string): SitePackChangeRecord {
  return {
    seq: 0,
    eventId,
    packId,
    fromVersion: 1,
    toVersion: 2,
    toSha256: 'c'.repeat(64),
    source: 'bundled',
    classification: 'unclassified',
    newDomains: [],
    notes: null,
    diff: [],
    decision: 'downloaded',
    decidedBy: null,
    createdAt: 1_000,
    decidedAt: null,
  };
}

describe('corrupt site-pack rows', () => {
  it('state: only the corrupt pack is left out and reported', async () => {
    db = await openMemory();
    const repos = db.repos;
    await repos.sitePackState.put(emptySitePackState('a.test', 1));
    await repos.sitePackState.put(emptySitePackState('b.test', 1));
    await sql`UPDATE site_pack_state SET approved_provenance_json = '{not json' WHERE pack_id = 'a.test'`.execute(
      db.handle.db,
    );
    await expect(repos.sitePackState.list()).rejects.toThrow();
    const bad: string[] = [];
    const rows = await repos.sitePackState.list({ onUnreadable: (id) => bad.push(id) });
    expect(rows.map((r) => r.packId)).toEqual(['b.test']);
    expect(bad).toEqual(['a.test']);
  });

  it('pending changes: a bad diff_json drops only that row; decide goes by event_id', async () => {
    db = await openMemory();
    const changes = db.repos.sitePackChanges;
    await changes.insert(pending('a.test', 'e-a'));
    await changes.insert(pending('b.test', 'e-b'));
    await sql`UPDATE site_pack_changes SET diff_json = '[{"path":1}]' WHERE event_id = 'e-a'`.execute(
      db.handle.db,
    );
    const bad: string[] = [];
    const rows = await changes.listPending({ onUnreadable: (id) => bad.push(id) });
    expect(rows.map((r) => r.eventId)).toEqual(['e-b']);
    expect(bad).toEqual(['a.test']);
    await changes.decide('e-b', 'rejected', 'p-op', 2_000);
    expect(await changes.listPending({ onUnreadable: () => undefined })).toEqual([]);
  });
});

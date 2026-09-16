/** @module app/maintenance/purge.test — inventory data (DB counts via the injected read-only open, directory sizes), rows, purge targets. */

import { describe, expect, it } from 'bun:test';
import type { PurgeInventory } from '../../ports/persistence/maintenance.ts';
import { inventoryRows, purge, purgeInventory } from './purge.ts';
import { MemoryFileSystem } from './test-support.ts';

const DB_INVENTORY: PurgeInventory = {
  path: '/data/browserhive.db',
  sizeBytes: 10,
  schemaVersion: 1,
  tables: [
    { table: 'sessions', rows: 2 },
    { table: 'tool_calls', rows: 40 },
  ],
  backups: [],
};

function populated() {
  const fs = new MemoryFileSystem();
  fs.addFile('/data/browserhive.db', '0123456789');
  fs.addFile('/data/browserhive.db-wal', 'wal');
  fs.addFile('/data/sessions/s1/trace.zip', '12345');
  fs.addFile('/data/sessions/s1/screenshots/a.jpg', '123');
  fs.addFile('/data/backups/browserhive-v1-x.db', '1234');
  fs.dirs.add('/data/uploads');
  return fs;
}

describe('purgeInventory', () => {
  it('reports DB tables and bytes (incl. WAL) and per-directory sizes', async () => {
    const fs = populated();
    const opened: string[] = [];
    const inv = await purgeInventory('/data', {
      fs,
      readInventory: async (path) => {
        opened.push(path);
        return DB_INVENTORY;
      },
    });
    expect(opened).toEqual(['/data/browserhive.db']);
    expect(inv.database).toMatchObject({ sizeBytes: 13, schemaVersion: 1, error: null });
    expect(inv.directories.map((d) => [d.name, d.exists, d.sizeBytes, d.files])).toEqual([
      ['sessions', true, 8, 2],
      ['auth-states', false, 0, 0],
      ['uploads', true, 0, 0],
      ['backups', true, 4, 1],
      ['admin', false, 0, 0],
    ]);
    expect(inv.totalBytes).toBe(25);
    expect(inventoryRows(inv).map((r) => [r.target, r.detail])).toEqual([
      ['database', '2 tables, 42 rows'],
      ['sessions', '2 files'],
      ['auth-states', 'missing'],
      ['uploads', '0 files'],
      ['backups', '1 files'],
      ['admin', 'missing'],
    ]);
  });

  it('keeps the size and the error when the database cannot be read; null when missing', async () => {
    const fs = populated();
    const broken = await purgeInventory('/data', {
      fs,
      readInventory: async () => {
        throw new Error('database is newer than this binary');
      },
    });
    expect(broken.database).toMatchObject({
      sizeBytes: 13,
      error: 'database is newer than this binary',
    });
    expect(inventoryRows(broken)[0]?.detail).toBe('database is newer than this binary');

    const empty = await purgeInventory('/nowhere', { fs, readInventory: async () => DB_INVENTORY });
    expect(empty.database).toBeNull();
    expect(inventoryRows(empty)[0]?.detail).toBe('missing');
  });
});

describe('purge', () => {
  const deps = (fs: MemoryFileSystem) => ({ fs, readInventory: async () => DB_INVENTORY });

  it('deletes only the chosen targets (DB with side files)', async () => {
    const fs = populated();
    const removed = await purge('/data', ['database', 'uploads'], deps(fs));
    expect(removed).toEqual(['/data/browserhive.db', '/data/browserhive.db-wal', '/data/uploads']);
    expect(fs.files.has('/data/sessions/s1/trace.zip')).toBe(true);
  });

  it('all removes everything that exists', async () => {
    const fs = populated();
    const removed = await purge('/data', [], deps(fs), { all: true });
    expect(removed).toEqual([
      '/data/browserhive.db',
      '/data/browserhive.db-wal',
      '/data/sessions',
      '/data/uploads',
      '/data/backups',
    ]);
    expect(fs.files.size).toBe(0);
  });
});

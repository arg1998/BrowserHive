/** @module test/cli/purge — `browserhive purge`: inventory from a fixture data dir, typed YES, a second YES for --all, --dryRun writes nothing, no-TTY refusal, open-session warning */
import { describe, expect, it } from 'bun:test';
import { cliHarness, DATA_DIR, MemoryFs, storageState } from './helpers.ts';

function fixture(): MemoryFs {
  return new MemoryFs({
    [`${DATA_DIR}/browserhive.db`]: 'x'.repeat(4000),
    [`${DATA_DIR}/browserhive.db-wal`]: 'w'.repeat(1000),
    [`${DATA_DIR}/sessions/shop-a1b2c3d4/trace.zip`]: 'z'.repeat(20_000),
    [`${DATA_DIR}/sessions/shop-a1b2c3d4/screenshots/e-1.png`]: 'p'.repeat(3000),
    [`${DATA_DIR}/auth-states/github.storage.json`]: '{}',
    [`${DATA_DIR}/admin/credentials.txt`]: 'secret\n',
    [`${DATA_DIR}/backups/browserhive-v1-20260915T000000000Z.db`]: 'b'.repeat(500),
  });
}

describe('purge', () => {
  it('renders the inventory (D-24 layout) and deletes after a typed YES', async () => {
    const fs = fixture();
    const run = await cliHarness({ argv: ['purge'], fs, answers: ['YES'] });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`BrowserHive data directory: ${DATA_DIR}`);
    expect(run.stdout).toContain('WILL BE DELETED — PERMANENTLY, WITH NO UNDO:');
    expect(run.stdout).toContain('Database (browserhive.db + WAL)');
    expect(run.stdout).toContain('123 rows  ·  5.0 kB');
    expect(run.stdout).toMatch(/ {8}tool_calls {11}120/);
    expect(run.stdout).toContain('2 files  ·  23.0 kB');
    expect(run.stdout).toContain('Total to reclaim: 28.0 kB');
    expect(run.stdout).toContain('WILL BE KEPT (pass --all to include these too):');
    expect(run.stdout).toContain(
      'Saved auth states (logged-in profiles + storage snapshots) — 1 files',
    );
    expect(run.prompts).toEqual(['Type YES to delete the above permanently: ']);
    expect(run.stdout).toContain('Purged. 28.0 kB reclaimed from');
    expect(await fs.stat(`${DATA_DIR}/browserhive.db`)).toBeNull();
    expect(await fs.stat(`${DATA_DIR}/browserhive.db-wal`)).toBeNull();
    expect(await fs.stat(`${DATA_DIR}/sessions`)).toBeNull();
    expect(await fs.stat(`${DATA_DIR}/auth-states/github.storage.json`)).not.toBeNull();
    expect(await fs.stat(`${DATA_DIR}/admin/credentials.txt`)).not.toBeNull();
    expect(run.storage.opened).toEqual([{ readOnly: true, migrate: false, owner: 'purge' }]);
  });

  it('--dryRun prints and writes nothing', async () => {
    const fs = fixture();
    const run = await cliHarness({ argv: ['purge', '--all', '--dryRun'], fs, answers: [] });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Dry run — nothing was deleted.');
    expect(run.prompts).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  it('anything but YES aborts with exit 1', async () => {
    const fs = fixture();
    const run = await cliHarness({ argv: ['purge'], fs, answers: ['yes'] });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('Aborted — nothing was deleted.');
    expect(fs.writes).toEqual([]);
  });

  it('--all asks a second YES and then deletes everything', async () => {
    const aborted = await cliHarness({
      argv: ['purge', '--all'],
      fs: fixture(),
      answers: ['YES', 'no'],
    });
    expect(aborted.code).toBe(1);
    expect(aborted.prompts).toHaveLength(2);
    expect(aborted.prompts[1]).toContain('Type YES again to confirm');
    expect(aborted.fs.writes).toEqual([]);

    const fs = fixture();
    const run = await cliHarness({ argv: ['purge', '--all'], fs, answers: ['YES', 'YES'] });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('--all includes saved auth states');
    expect(run.stdout).toContain('Vault bindings and group policies live in the database');
    expect(run.stdout).not.toContain('WILL BE KEPT');
    for (const dir of ['sessions', 'auth-states', 'uploads', 'backups', 'admin']) {
      expect(await fs.stat(`${DATA_DIR}/${dir}`)).toBeNull();
    }
  });

  it('refuses without a TTY and without --yes (exit 1)', async () => {
    const fs = fixture();
    const run = await cliHarness({ argv: ['purge'], fs, answers: null });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      'browserhive purge: refusing to delete without confirmation, and stdin is not a terminal.',
    );
    expect(fs.writes).toEqual([]);
  });

  it('--yes skips the prompts', async () => {
    const run = await cliHarness({
      argv: ['purge', '--all', '--yes'],
      fs: fixture(),
      answers: null,
    });
    expect(run.code).toBe(0);
    expect(run.prompts).toEqual([]);
  });

  it('warns about open sessions and a live lock holder', async () => {
    const run = await cliHarness({
      argv: ['purge', '--dryRun'],
      fs: fixture(),
      storage: storageState({ openSessions: 2 }),
      lock: { pid: 4242, owner: 'serve', startedAt: 1 },
    });
    expect(run.stdout).toContain('2 session(s) are still marked open.');
    expect(run.stdout).toContain('A BrowserHive process (pid 4242) holds this data directory.');
  });

  it('a missing data dir is nothing to do', async () => {
    const run = await cliHarness({ argv: ['purge'], answers: null });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Nothing to purge — that directory does not exist.');
  });

  it('a server flag on purge is a usage error (64)', async () => {
    const run = await cliHarness({ argv: ['purge', '--port', '9000'] });
    expect(run.code).toBe(64);
    expect(run.stderr).toContain("--port is not accepted by 'browserhive purge'");
  });

  it('an unreadable database still lists its size', async () => {
    const run = await cliHarness({
      argv: ['purge', '--dryRun'],
      fs: fixture(),
      openError: new Error('database disk image is malformed'),
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('unreadable (database disk image is malformed)');
  });
});

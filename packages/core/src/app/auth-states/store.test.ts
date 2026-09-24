/** @module app/auth-states/store.test — save/list/remove/restore, owner scoping, identity seed round trip, name sandbox. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { AuthStateStore, assertValidAuthName } from './store.ts';

const local = { subject: 'local' };
const alice = { subject: 'alice' };
let dir: string;
let clock: FakeClock;
let store: AuthStateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bh-auth-'));
  clock = new FakeClock();
  store = new AuthStateStore({ dataDir: dir, clock, logger: createCollectingLogger() });
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const storageStateCalls: { path: string; indexedDB: boolean }[] = [];
const source = {
  storageState: async (options: { path: string; indexedDB: boolean }) => {
    storageStateCalls.push(options);
    await writeFile(
      options.path,
      JSON.stringify({ cookies: [{ name: 'sid', value: 'v' }], origins: [] }),
    );
  },
};

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected a failure');
  } catch (err) {
    expect(isAppError(err) ? err.code : String(err)).toBe(code);
  }
}

describe('AuthStateStore', () => {
  it('saves a storage state 0600 with a manifest and lists it newest first per owner', async () => {
    const saved = await store.saveStorageState(source, 'first', 'demo-00000001', local);
    expect(saved.path).toBe(join(dir, 'auth-states', 'first.storage.json'));
    expect(storageStateCalls.at(-1)).toEqual({ path: saved.path, indexedDB: true });
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(
      await readFile(join(dir, 'auth-states', 'first.meta.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({
      name: 'first',
      kind: 'storage',
      owner: 'local',
      source_session_id: 'demo-00000001',
    });
    await clock.advance(10);
    const userdata = join(dir, 'profile');
    await mkdir(join(userdata, 'Default'), { recursive: true });
    await writeFile(join(userdata, 'Default', 'Cookies'), 'db');
    await store.saveFullProfile(userdata, 'second', 'prof-00000001', local);
    expect((await store.list(local)).map((e) => [e.name, e.kind])).toEqual([
      ['second', 'profile'],
      ['first', 'storage'],
    ]);
    expect(await store.list(alice)).toEqual([]);
  });

  it('resolves and restores only the owner’s snapshots', async () => {
    await store.saveStorageState(source, 'mine', 'demo-00000001', local);
    expect(await store.storageStatePath('mine', local)).toEndWith('mine.storage.json');
    await expectCode(store.storageStatePath('mine', alice), 'AUTH_STATE_NOT_FOUND');
    await expectCode(store.storageStatePath('missing', local), 'AUTH_STATE_NOT_FOUND');
    await expectCode(
      store.restoreProfile('missing', join(dir, 'x'), local),
      'AUTH_STATE_NOT_FOUND',
    );
  });

  it('round-trips a profile (regular files only) and its identity seed', async () => {
    const userdata = join(dir, 'src');
    await mkdir(join(userdata, 'Default'), { recursive: true });
    await writeFile(join(userdata, 'Default', 'Local State'), 'state');
    await symlink('/etc/passwd', join(userdata, 'SingletonLock'));
    await store.saveFullProfile(userdata, 'work', 'prof-00000001', local);
    expect(await store.saveIdentitySeed('work', 'prof-00000001')).toBe(true);
    const dest = join(dir, 'dest');
    await store.restoreProfile('work', dest, local);
    expect(await readFile(join(dest, 'Default', 'Local State'), 'utf8')).toBe('state');
    expect(await stat(join(dest, 'SingletonLock')).catch(() => null)).toBeNull();
    expect(await store.loadIdentitySeed('work')).toBe('prof-00000001');
    expect(await store.loadIdentitySeed('none')).toBeNull();
  });

  it('removes every file of a snapshot the caller owns', async () => {
    await store.saveStorageState(source, 'gone', 'demo-00000001', local);
    expect(await store.remove('gone', alice)).toBe(false);
    expect(await store.remove('gone', local)).toBe(true);
    expect(await store.list(local)).toEqual([]);
    expect(await store.remove('gone', local)).toBe(false);
  });

  it('treats a manifest without an owner as local', async () => {
    await mkdir(join(dir, 'auth-states'), { recursive: true });
    await writeFile(
      join(dir, 'auth-states', 'old.meta.json'),
      JSON.stringify({
        name: 'old',
        kind: 'storage',
        saved_at: 1,
        source_session_id: 's',
        size: 2,
      }),
    );
    expect((await store.list(local)).map((e) => e.name)).toEqual(['old']);
  });

  it('refuses unsafe names with PATH_NOT_ALLOWED', () => {
    for (const name of ['../evil', 'a/b', '', '.hidden', 'a..b', 'x'.repeat(65)]) {
      expect(() => assertValidAuthName(name)).toThrow();
    }
    expect(() => assertValidAuthName('my-login.v2_ok')).not.toThrow();
  });
});

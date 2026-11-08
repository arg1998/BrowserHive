/** @module app/auth-states/store.test — save/list/remove/restore, per-principal names (spec 13 T0a), identity seed round trip, flat-layout migration, name sandbox. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import {
  type AuthStateFs,
  AuthStateStore,
  assertValidAuthName,
  createNodeAuthStateFs,
  principalDirName,
} from './store.ts';

const local = { subject: 'local' };
const alice = { subject: 'alice' };
const bob = { subject: 'bob' };
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
    // Windows has no POSIX modes; the file checks above still run there.
    if (process.platform !== 'win32') expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
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
    // A link the zip must skip. Windows needs a privilege for file symlinks, so there it is a
    // junction to a directory: just as much a non-regular entry.
    if (process.platform === 'win32') {
      const target = join(dir, 'link-target');
      await mkdir(target);
      await symlink(target, join(userdata, 'SingletonLock'), 'junction');
    } else {
      await symlink('/etc/passwd', join(userdata, 'SingletonLock'));
    }
    await store.saveFullProfile(userdata, 'work', 'prof-00000001', local);
    expect(await store.saveIdentitySeed('work', 'prof-00000001', local)).toBe(true);
    const dest = join(dir, 'dest');
    await store.restoreProfile('work', dest, local);
    expect(await readFile(join(dest, 'Default', 'Local State'), 'utf8')).toBe('state');
    expect(await stat(join(dest, 'SingletonLock')).catch(() => null)).toBeNull();
    expect(await store.loadIdentitySeed('work', local)).toBe('prof-00000001');
    expect(await store.loadIdentitySeed('none', local)).toBeNull();
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

/** A source whose snapshot carries `value` as its `sid` cookie. */
function sourceWith(value: string) {
  return {
    storageState: async (options: { path: string; indexedDB: boolean }) => {
      await writeFile(
        options.path,
        JSON.stringify({ cookies: [{ name: 'sid', value }], origins: [] }),
      );
    },
  };
}

/** A managed userdata dir whose `Default/Cookies` holds `cookies`. */
async function userdataWith(label: string, cookies: string): Promise<string> {
  const userdata = join(dir, `ud-${label}`);
  await mkdir(join(userdata, 'Default'), { recursive: true });
  await writeFile(join(userdata, 'Default', 'Cookies'), cookies);
  return userdata;
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

type Kind = 'storage' | 'profile';

async function saveAs(
  kind: Kind,
  name: string,
  principal: { subject: string },
  secret: string,
): Promise<void> {
  if (kind === 'storage') {
    await store.saveStorageState(sourceWith(secret), name, `s-${principal.subject}`, principal);
  } else {
    const userdata = await userdataWith(`${principal.subject}-${kind}`, secret);
    await store.saveFullProfile(userdata, name, `s-${principal.subject}`, principal);
  }
}

/** What a restore of `name` as `principal` yields: the secret, or the error code. */
async function restoredSecret(kind: Kind, name: string, principal: { subject: string }) {
  try {
    if (kind === 'storage') {
      const path = await store.storageStatePath(name, principal);
      const state = JSON.parse(await readFile(path, 'utf8')) as {
        cookies: { value: string }[];
      };
      return state.cookies[0]?.value;
    }
    const dest = join(dir, `restore-${principal.subject}-${Math.random()}`);
    await store.restoreProfile(name, dest, principal);
    return await readFile(join(dest, 'Default', 'Cookies'), 'utf8');
  } catch (err) {
    return isAppError(err) ? err.code : String(err);
  }
}

describe('AuthStateStore names per principal (spec 13 T0a)', () => {
  const kinds: Kind[] = ['storage', 'profile'];
  for (const first of kinds) {
    for (const second of kinds) {
      it(`bob saving alice's ${first} name as a ${second} leaves alice's snapshot alone`, async () => {
        await saveAs(first, 'work', alice, 'ALICE');
        await saveAs(second, 'work', bob, 'BOB');
        expect((await store.list(alice)).map((e) => [e.name, e.kind])).toEqual([['work', first]]);
        expect((await store.list(bob)).map((e) => [e.name, e.kind])).toEqual([['work', second]]);
        // Each restores only its own; the other kind under the same name is simply not found.
        expect(await restoredSecret(first, 'work', alice)).toBe('ALICE');
        expect(await restoredSecret(second, 'work', bob)).toBe('BOB');
        if (first !== second) {
          expect(await restoredSecret(first, 'work', bob)).toBe('AUTH_STATE_NOT_FOUND');
          expect(await restoredSecret(second, 'work', alice)).toBe('AUTH_STATE_NOT_FOUND');
        }
        expect(await restoredSecret(first, 'work', local)).toBe('AUTH_STATE_NOT_FOUND');
        expect(await store.list(local)).toEqual([]);
      });
    }
  }

  it('lays out local flat and everyone else under p/<sha256(subject)[:16]>/', async () => {
    const mine = await store.saveStorageState(source, 'x', 's', local);
    const theirs = await store.saveStorageState(source, 'x', 's', alice);
    expect(mine.path).toBe(join(dir, 'auth-states', 'x.storage.json'));
    expect(principalDirName('alice')).toMatch(/^[0-9a-f]{16}$/);
    expect(theirs.path).toBe(
      join(dir, 'auth-states', 'p', principalDirName('alice'), 'x.storage.json'),
    );
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'auth-states', 'p'))).mode & 0o777).toBe(0o700);
      expect(
        (await stat(join(dir, 'auth-states', 'p', principalDirName('alice')))).mode & 0o777,
      ).toBe(0o700);
    }
  });

  it('keeps identity seeds per principal', async () => {
    await saveAs('profile', 'work', alice, 'ALICE');
    expect(await store.saveIdentitySeed('work', 'alice-seed', alice)).toBe(true);
    // Bob has no profile of that name: no seed is written for him and alice's stays.
    expect(await store.saveIdentitySeed('work', 'bob-seed', bob)).toBe(false);
    expect(await store.loadIdentitySeed('work', bob)).toBeNull();
    await saveAs('profile', 'work', bob, 'BOB');
    expect(await store.loadIdentitySeed('work', bob)).toBeNull();
    expect(await store.saveIdentitySeed('work', 'bob-seed', bob)).toBe(true);
    expect(await store.loadIdentitySeed('work', alice)).toBe('alice-seed');
    expect(await store.loadIdentitySeed('work', bob)).toBe('bob-seed');
    expect(await store.loadIdentitySeed('work', local)).toBeNull();
  });

  it('one name is one snapshot: saving the other kind drops the stale payload and the seed', async () => {
    await saveAs('profile', 'work', alice, 'ALICE-PROFILE');
    await store.saveIdentitySeed('work', 'alice-seed', alice);
    const files = store.filesFor('alice', 'work');
    await saveAs('storage', 'work', alice, 'ALICE-STORAGE');
    expect(await exists(files.profile)).toBe(false);
    expect(await exists(files.identity)).toBe(false);
    expect(await store.loadIdentitySeed('work', alice)).toBeNull();
    expect(await restoredSecret('storage', 'work', alice)).toBe('ALICE-STORAGE');
    await saveAs('profile', 'work', alice, 'ALICE-PROFILE-2');
    expect(await exists(files.storage)).toBe(false);
    expect(await restoredSecret('profile', 'work', alice)).toBe('ALICE-PROFILE-2');
    expect((await store.list(alice)).map((e) => e.kind)).toEqual(['profile']);
  });

  it('restore requires the manifest kind to match the requested kind', async () => {
    await saveAs('storage', 'work', local, 'LOCAL');
    // A stale profile payload beside a storage manifest (left by an older release) is never restored.
    await writeFile(join(dir, 'auth-states', 'work.profile.zip'), 'not-restored');
    await writeFile(
      join(dir, 'auth-states', 'work.identity.json'),
      JSON.stringify({ seed: 'stale' }),
    );
    expect(await restoredSecret('profile', 'work', local)).toBe('AUTH_STATE_NOT_FOUND');
    expect(await store.loadIdentitySeed('work', local)).toBeNull();
    expect(await restoredSecret('storage', 'work', local)).toBe('LOCAL');
  });

  it('answers the same not-found for a foreign name as for a missing one', async () => {
    await saveAs('storage', 'work', alice, 'ALICE');
    await saveAs('profile', 'deep', alice, 'ALICE');
    const errorOf = async (p: Promise<unknown>) =>
      p.then(
        () => null,
        (err: unknown) => (isAppError(err) ? [err.code, err.publicMessage] : String(err)),
      );
    expect(await errorOf(store.storageStatePath('work', bob))).toEqual(
      await errorOf(store.storageStatePath('work', { subject: 'nobody' })),
    );
    expect(await errorOf(store.restoreProfile('deep', join(dir, 'd1'), bob))).toEqual(
      await errorOf(store.restoreProfile('deep', join(dir, 'd2'), { subject: 'nobody' })),
    );
    expect(await store.list(bob)).toEqual([]);
    expect(await store.remove('work', bob)).toBe(false);
    expect(await restoredSecret('storage', 'work', alice)).toBe('ALICE');
  });
});

/** Writes a pre-T0a flat snapshot: payload, optional seed and a manifest with `owner` (omitted when `undefined`). */
async function writeFlat(
  name: string,
  kind: Kind,
  owner: string | undefined,
  options: { secret?: string; seed?: string; savedAt?: number } = {},
): Promise<void> {
  const flat = join(dir, 'auth-states');
  await mkdir(flat, { recursive: true });
  const secret = options.secret ?? `${owner ?? 'none'}-secret`;
  if (kind === 'storage') {
    await writeFile(
      join(flat, `${name}.storage.json`),
      JSON.stringify({ cookies: [{ name: 'sid', value: secret }], origins: [] }),
    );
  } else {
    // A real archive, built by a throwaway store under another data dir.
    const other = new AuthStateStore({
      dataDir: join(dir, `build-${name}-${Math.random()}`),
      clock,
      logger: createCollectingLogger(),
    });
    const saved = await other.saveFullProfile(
      await userdataWith(`flat-${name}`, secret),
      name,
      's',
      local,
    );
    await writeFile(join(flat, `${name}.profile.zip`), await readFile(saved.path));
  }
  if (options.seed !== undefined) {
    await writeFile(join(flat, `${name}.identity.json`), JSON.stringify({ seed: options.seed }));
  }
  await writeFile(
    join(flat, `${name}.meta.json`),
    JSON.stringify({
      name,
      kind,
      saved_at: options.savedAt ?? 1,
      source_session_id: 's',
      size: 2,
      ...(owner !== undefined && { owner }),
    }),
  );
}

describe('AuthStateStore flat-layout migration (spec 13 T0a)', () => {
  it('moves a flat snapshot with a non-local owner, seed included, into its owner directory on first access', async () => {
    await writeFlat('work', 'profile', 'alice', { secret: 'ALICE', seed: 'alice-seed' });
    const fresh = new AuthStateStore({ dataDir: dir, clock, logger: createCollectingLogger() });
    // The first access of any principal runs the move.
    expect(await fresh.list(local)).toEqual([]);
    const files = fresh.filesFor('alice', 'work');
    for (const path of [files.profile, files.identity, files.manifest]) {
      expect(await exists(path)).toBe(true);
    }
    for (const ext of ['profile.zip', 'identity.json', 'meta.json']) {
      expect(await exists(join(dir, 'auth-states', `work.${ext}`))).toBe(false);
    }
    store = fresh;
    expect(await restoredSecret('profile', 'work', alice)).toBe('ALICE');
    expect(await fresh.loadIdentitySeed('work', alice)).toBe('alice-seed');
    expect((await fresh.list(alice)).map((e) => e.name)).toEqual(['work']);
    expect(await restoredSecret('profile', 'work', local)).toBe('AUTH_STATE_NOT_FOUND');
  });

  it('keeps a legacy owner-less manifest local and in place', async () => {
    await writeFlat('old', 'storage', undefined, { secret: 'LOCAL' });
    await writeFlat('mine', 'storage', 'local', { secret: 'LOCAL2' });
    expect((await store.list(local)).map((e) => e.name).sort()).toEqual(['mine', 'old']);
    expect(await exists(join(dir, 'auth-states', 'old.meta.json'))).toBe(true);
    expect(await exists(join(dir, 'auth-states', 'p'))).toBe(false);
    expect(await restoredSecret('storage', 'old', local)).toBe('LOCAL');
    expect(await restoredSecret('storage', 'old', alice)).toBe('AUTH_STATE_NOT_FOUND');
    expect(await store.list(alice)).toEqual([]);
  });

  it('is idempotent', async () => {
    await writeFlat('work', 'storage', 'alice', { secret: 'ALICE' });
    expect(await store.migrateFlatLayout()).toBe(true);
    expect(await store.migrateFlatLayout()).toBe(true);
    expect(await restoredSecret('storage', 'work', alice)).toBe('ALICE');
  });

  it('loses nothing when a crash interrupts the move, and finishes it on the next start', async () => {
    await writeFlat('work', 'profile', 'alice', { secret: 'ALICE', seed: 'alice-seed' });
    const real = createNodeAuthStateFs();
    let renames = 0;
    // The second rename (the seed) fails as if the process died there.
    const crashing: AuthStateFs = {
      ...real,
      rename: async (from, to) => {
        renames += 1;
        if (renames === 2) throw new Error('simulated crash');
        await real.rename(from, to);
      },
    };
    const before = new AuthStateStore({
      dataDir: dir,
      clock,
      logger: createCollectingLogger(),
      fs: crashing,
    });
    expect(await before.migrateFlatLayout()).toBe(false);
    // Half moved: the payload is in alice's directory, the seed and the manifest still flat.
    const files = before.filesFor('alice', 'work');
    expect(await exists(files.profile)).toBe(true);
    expect(await exists(join(dir, 'auth-states', 'work.identity.json'))).toBe(true);
    expect(await exists(join(dir, 'auth-states', 'work.meta.json'))).toBe(true);
    // Nobody can read the half-moved snapshot meanwhile, and local never sees it.
    expect(await before.list(local)).toEqual([]);
    // The next start finishes the move.
    store = new AuthStateStore({ dataDir: dir, clock, logger: createCollectingLogger() });
    expect((await store.list(alice)).map((e) => e.name)).toEqual(['work']);
    expect(await restoredSecret('profile', 'work', alice)).toBe('ALICE');
    expect(await store.loadIdentitySeed('work', alice)).toBe('alice-seed');
    expect(await exists(join(dir, 'auth-states', 'work.meta.json'))).toBe(false);
  });

  it('retries a failed move on the next access of the same process', async () => {
    await writeFlat('work', 'storage', 'alice', { secret: 'ALICE' });
    const real = createNodeAuthStateFs();
    let failNext = true;
    const flaky: AuthStateFs = {
      ...real,
      rename: async (from, to) => {
        if (failNext) {
          failNext = false;
          throw new Error('simulated EBUSY');
        }
        await real.rename(from, to);
      },
    };
    store = new AuthStateStore({
      dataDir: dir,
      clock,
      logger: createCollectingLogger(),
      fs: flaky,
    });
    expect(await store.list(alice)).toEqual([]);
    expect((await store.list(alice)).map((e) => e.name)).toEqual(['work']);
  });

  it('a local save of a name whose flat manifest is still foreign moves it first', async () => {
    await writeFlat('work', 'storage', 'alice', { secret: 'ALICE' });
    const real = createNodeAuthStateFs();
    let failFirst = true;
    store = new AuthStateStore({
      dataDir: dir,
      clock,
      logger: createCollectingLogger(),
      fs: {
        ...real,
        rename: async (from, to) => {
          if (failFirst) {
            failFirst = false;
            throw new Error('simulated EBUSY');
          }
          await real.rename(from, to);
        },
      },
    });
    expect(await store.migrateFlatLayout()).toBe(false);
    await saveAs('storage', 'work', local, 'LOCAL');
    expect(await restoredSecret('storage', 'work', local)).toBe('LOCAL');
    expect(await restoredSecret('storage', 'work', alice)).toBe('ALICE');
  });

  it('keeps the newer copy when the owner already has the name (a downgrade saved one flat)', async () => {
    await saveAs('storage', 'work', alice, 'ALICE-NEW');
    const newest = (await store.list(alice))[0]?.saved_at ?? 0;
    await writeFlat('work', 'storage', 'alice', { secret: 'ALICE-OLD', savedAt: newest - 1 });
    await writeFlat('deep', 'storage', 'alice', { secret: 'ALICE-FLAT', savedAt: newest + 5 });
    await saveAs('storage', 'deep', alice, 'ALICE-DIR');
    // `deep` was saved in alice's directory before the flat copy appeared, but the flat one is newer.
    await writeFile(
      store.filesFor('alice', 'deep').manifest,
      JSON.stringify({
        name: 'deep',
        kind: 'storage',
        saved_at: newest,
        source_session_id: 's',
        size: 2,
        owner: 'alice',
      }),
    );
    store = new AuthStateStore({ dataDir: dir, clock, logger: createCollectingLogger() });
    expect(await restoredSecret('storage', 'work', alice)).toBe('ALICE-NEW');
    expect(await restoredSecret('storage', 'deep', alice)).toBe('ALICE-FLAT');
    expect(await exists(join(dir, 'auth-states', 'work.meta.json'))).toBe(false);
    expect(await exists(join(dir, 'auth-states', 'deep.meta.json'))).toBe(false);
  });
});

describe('AuthStateStore operator view (listAll, removeSnapshot)', () => {
  it("lists every principal's snapshots newest first with owner and source session", async () => {
    await saveAs('storage', 'work', local, 'LOCAL');
    await clock.advance(10);
    await saveAs('profile', 'work', alice, 'ALICE');
    await clock.advance(10);
    await saveAs('storage', 'other', bob, 'BOB');
    expect(
      (await store.listAll()).map((r) => [r.owner, r.name, r.kind, r.source_session_id]),
    ).toEqual([
      ['bob', 'other', 'storage', 's-bob'],
      ['alice', 'work', 'profile', 's-alice'],
      ['local', 'work', 'storage', 's-local'],
    ]);
  });

  it('lists only what removeSnapshot can reach: no stray manifest from another directory', async () => {
    await saveAs('storage', 'work', alice, 'ALICE');
    // A manifest naming bob inside alice's directory (hand-copied) is not bob's and not alice's.
    const stray = store.filesFor('alice', 'stray').manifest;
    await writeFile(
      stray,
      JSON.stringify({
        name: 'stray',
        kind: 'storage',
        saved_at: 1,
        source_session_id: 's',
        size: 2,
        owner: 'bob',
      }),
    );
    expect((await store.listAll()).map((r) => [r.owner, r.name])).toEqual([['alice', 'work']]);
  });

  it("removes another owner's snapshot for the operator and reports what it was", async () => {
    await saveAs('profile', 'work', alice, 'ALICE');
    await store.saveIdentitySeed('work', 'alice-seed', alice);
    await saveAs('storage', 'work', bob, 'BOB');
    const removed = await store.removeSnapshot('alice', 'work');
    expect(removed).toMatchObject({ owner: 'alice', name: 'work', kind: 'profile' });
    const files = store.filesFor('alice', 'work');
    for (const path of Object.values(files)) expect(await exists(path)).toBe(false);
    expect(await store.removeSnapshot('alice', 'work')).toBeNull();
    // Bob's snapshot of the same name is untouched.
    expect(await restoredSecret('storage', 'work', bob)).toBe('BOB');
  });

  it('remove deletes whatever is left of a partial file set, manifest last', async () => {
    await saveAs('profile', 'work', alice, 'ALICE');
    await store.saveIdentitySeed('work', 'alice-seed', alice);
    const files = store.filesFor('alice', 'work');
    // As after an interrupted delete: the payload is gone, the seed and the manifest are left.
    await rm(files.profile);
    expect((await store.list(alice)).map((e) => e.name)).toEqual(['work']);
    expect(await store.remove('work', alice)).toBe(true);
    for (const path of Object.values(files)) expect(await exists(path)).toBe(false);
    expect(await store.list(alice)).toEqual([]);
    // A manifest is what makes a snapshot exist: payloads without one are not removable by name.
    await writeFile(files.storage, '{}');
    expect(await store.remove('work', alice)).toBe(false);
  });

  it('publishes auth_state.changed after a save and a delete', async () => {
    const published: unknown[] = [];
    store = new AuthStateStore({
      dataDir: dir,
      clock,
      logger: createCollectingLogger(),
      events: { publish: (_name, payload) => void published.push(payload) },
    });
    await saveAs('storage', 'work', alice, 'ALICE');
    await store.remove('work', alice);
    await store.remove('work', alice);
    expect(published).toEqual([
      { type: 'auth_state.changed', owner: 'alice', name: 'work', action: 'saved' },
      { type: 'auth_state.changed', owner: 'alice', name: 'work', action: 'deleted' },
    ]);
  });
});

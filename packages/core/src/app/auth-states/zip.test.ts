/** @module app/auth-states/zip.test — streamed zip round trip (byte for byte, old `zipSync` archives too), cache exclusion, atomic write, the zip-slip guard, and live-profile reads (vanished files, held lock markers). */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { createNodeAuthStateFs } from './store.ts';
import {
  PROFILE_CACHE_DIRS,
  PROFILE_LOCK_FILES,
  unzipFileToDirectory,
  type ZipFs,
  zipDirectoryToFile,
} from './zip.ts';

let dir: string;
const fs = createNodeAuthStateFs();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bh-zip-'));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

/** Writes `files` (relative POSIX path → content) under `root`. */
async function writeTree(root: string, files: Readonly<Record<string, Uint8Array | string>>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    await fs.mkdir(dirname(abs));
    await writeFile(abs, content);
  }
}

/** Every regular file under `root` as relative POSIX path → bytes. */
async function readTree(root: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out[abs.slice(root.length + 1).replaceAll('\\', '/')] = new Uint8Array(await readFile(abs));
  }
  return out;
}

/** Zips `root` into `<dir>/out.zip` and returns the archive's entries (decoded by fflate). */
async function zipEntries(root: string, zipFs: ZipFs = fs): Promise<Record<string, Uint8Array>> {
  const archive = join(dir, 'out.zip');
  await zipDirectoryToFile(root, archive, zipFs);
  return unzipSync(new Uint8Array(await readFile(archive)));
}

/** A profile-shaped tree: text, binary larger than one slice, empty, nested, and a UTF-8 name. */
function sampleTree(): Record<string, Uint8Array | string> {
  // Incompressible bytes with zip signatures in them, as an embedded zip or crx would have:
  // deflate stores such data verbatim, so a signature-scanning unzipper would cut it apart.
  const binary = new Uint8Array(randomBytes(700 * 1024));
  for (let i = 0; i < binary.length - 4; i += 4099) binary.set([0x50, 0x4b, 0x03, 0x04], i);
  binary.set([0x50, 0x4b, 0x07, 0x08], 17);
  // Sparse bytes like a SQLite journal: fflate 0.8.3's streaming deflate corrupts exactly these.
  const sparse = new Uint8Array(40);
  sparse[12] = 0x69;
  const journal = new Uint8Array(58_000);
  for (let i = 0; i < journal.length; i += 4096)
    journal.set([0xd9, 0xd5, 0x05, 0xf9, i & 0xff], i + 12);
  return {
    'Default/History-journal': journal,
    'Default/sparse': sparse,
    'Local State': '{"profile":{}}',
    'Default/Preferences': '{"a":1}',
    'Default/Network/Cookies': binary,
    'Default/Local Storage/leveldb/000003.log': 'x'.repeat(300 * 1024),
    'Default/Local Storage/leveldb/LOCK': '',
    'Default/IndexedDB/https_example.com_0.indexeddb.leveldb/CURRENT': 'MANIFEST-000001\n',
    'Default/Extension State/naïve ✓.txt': 'utf-8 name',
  };
}

describe('profile zips', () => {
  it('round-trips a profile byte for byte through the file archive', async () => {
    const tree = sampleTree();
    await writeTree(join(dir, 'src'), tree);
    const archive = join(dir, 'auth', 'p.profile.zip');
    await fs.mkdir(join(dir, 'auth'));
    const size = await zipDirectoryToFile(join(dir, 'src'), archive, fs);
    expect(size).toBe((await stat(archive)).size);
    if (process.platform !== 'win32') expect((await stat(archive)).mode & 0o777).toBe(0o600);
    // Nothing but the archive is left beside it (no temp file).
    expect(await readdir(join(dir, 'auth'))).toEqual(['p.profile.zip']);
    await unzipFileToDirectory(archive, join(dir, 'out'), fs);
    const restored = await readTree(join(dir, 'out'));
    const expected = Object.fromEntries(
      Object.entries(tree).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]),
    );
    expect(Object.keys(restored).sort()).toEqual(Object.keys(expected).sort());
    for (const [rel, bytes] of Object.entries(expected)) {
      expect(Buffer.compare(restored[rel] ?? new Uint8Array(), bytes)).toBe(0);
    }
    // A standard reader (fflate's central-directory unzip) reads the streamed archive too.
    expect(Object.keys(unzipSync(new Uint8Array(await readFile(archive)))).sort()).toEqual(
      Object.keys(expected).sort(),
    );
  });

  it('restores an archive written by the earlier in-memory zipSync (existing snapshots)', async () => {
    const tree = sampleTree();
    const payload = Object.fromEntries(
      Object.entries(tree).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]),
    );
    // Exactly what 0.2.2 wrote: flat relative keys, level 6.
    const old = join(dir, 'old.profile.zip');
    await writeFile(old, zipSync(payload, { level: 6 }));
    await unzipFileToDirectory(old, join(dir, 'out'), fs);
    const restored = await readTree(join(dir, 'out'));
    for (const [rel, bytes] of Object.entries(payload)) {
      expect(Buffer.compare(restored[rel] ?? new Uint8Array(), bytes)).toBe(0);
    }
  });

  it('refuses an entry that escapes the destination (zip-slip) before writing any file', async () => {
    const evil = join(dir, 'evil.zip');
    await writeFile(evil, zipSync({ 'ok.txt': strToU8('fine'), '../escape.txt': strToU8('x') }));
    try {
      await unzipFileToDirectory(evil, join(dir, 'out'), fs);
      throw new Error('expected PATH_NOT_ALLOWED');
    } catch (err) {
      expect(isAppError(err, 'PATH_NOT_ALLOWED')).toBe(true);
    }
    expect(await readFile(join(dir, 'escape.txt')).catch(() => null)).toBeNull();
    expect(await readFile(join(dir, 'out', 'ok.txt')).catch(() => null)).toBeNull();
  });

  it('fails on a truncated archive instead of restoring part of it', async () => {
    await writeTree(join(dir, 'src'), sampleTree());
    const archive = join(dir, 'p.zip');
    await zipDirectoryToFile(join(dir, 'src'), archive, fs);
    const bytes = await readFile(archive);
    await writeFile(archive, bytes.subarray(0, bytes.length - 10));
    await expect(unzipFileToDirectory(archive, join(dir, 'out'), fs)).rejects.toThrow(
      'profile archive is corrupt',
    );
  });
});

describe('cache exclusion', () => {
  it('leaves out regenerable cache directories at any depth and keeps every login file', async () => {
    const root = join(dir, 'profile');
    const caches: Record<string, string> = {};
    for (const cache of PROFILE_CACHE_DIRS) {
      caches[`Default/${cache}/data_0`] = 'cached';
      caches[`Profile 1/${cache}/sub/f`] = 'cached';
    }
    const logins = {
      'Default/Cookies': 'c',
      'Default/Network/Cookies': 'c',
      'Default/Login Data': 'l',
      'Default/Preferences': 'p',
      'Default/Local Storage/leveldb/000003.log': 'ls',
      'Default/Session Storage/000003.log': 'ss',
      'Default/IndexedDB/https_a.test_0.indexeddb.leveldb/000003.log': 'idb',
      'Default/Service Worker/Database/000003.log': 'sw',
      // Only the exact names are caches.
      'Default/Shared Dictionary/cache/db': 'kept',
      'Default/CacheStorage/f': 'kept',
      'Default/My Cache/f': 'kept',
    };
    await writeTree(root, {
      ...caches,
      ...logins,
      'GrShaderCache/data_1': 'cached',
      'ShaderCache/data_1': 'cached',
      'component_crx_cache/x.crx': 'cached',
      'GPUPersistentCache/GPUCache/k': 'cached',
    });
    const entries = await zipEntries(root);
    expect(Object.keys(entries).sort()).toEqual(Object.keys(logins).sort());
  });
});

describe('atomic write', () => {
  it('leaves no archive and no temp file when a write fails midway', async () => {
    await writeTree(join(dir, 'src'), sampleTree());
    const target = join(dir, 'auth', 'p.profile.zip');
    await fs.mkdir(join(dir, 'auth'));
    let writes = 0;
    const failing: ZipFs = {
      ...fs,
      createTemp: async (path, mode) => {
        const temp = await fs.createTemp(path, mode);
        return {
          path: temp.path,
          handle: {
            ...temp.handle,
            write: async (data) => {
              if (++writes === 3)
                throw Object.assign(new Error('ENOSPC: full'), { code: 'ENOSPC' });
              await temp.handle.write(data);
            },
          },
        };
      },
    };
    await expect(zipDirectoryToFile(join(dir, 'src'), target, failing)).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(await readdir(join(dir, 'auth'))).toEqual([]);
  });

  it('keeps an existing snapshot intact when a later save fails', async () => {
    await writeTree(join(dir, 'src'), sampleTree());
    const target = join(dir, 'auth', 'p.profile.zip');
    await fs.mkdir(join(dir, 'auth'));
    await zipDirectoryToFile(join(dir, 'src'), target, fs);
    const before = await readFile(target);
    await writeTree(join(dir, 'src'), { 'Default/Login Data': 'l' });
    await expect(
      zipDirectoryToFile(join(dir, 'src'), target, liveFs({ 'Login Data': 'EIO' }, 'read')),
    ).rejects.toMatchObject({ code: 'EIO' });
    expect(Buffer.compare(await readFile(target), before)).toBe(0);
    expect(await readdir(join(dir, 'auth'))).toEqual(['p.profile.zip']);
  });
});

/**
 * A real tree, with opening (or the first read of) chosen files failing the way a live browser
 * makes it.
 */
function liveFs(failures: Readonly<Record<string, string>>, at: 'open' | 'read' = 'open'): ZipFs {
  const failure = (path: string): Error | null => {
    for (const [suffix, code] of Object.entries(failures)) {
      if (path.endsWith(suffix)) return Object.assign(new Error(`${code}: read`), { code });
    }
    return null;
  };
  return {
    ...fs,
    openRead: async (path) => {
      const error = failure(path);
      if (error !== null && at === 'open') throw error;
      const handle = await fs.openRead(path);
      return error === null ? handle : { ...handle, read: async () => Promise.reject(error) };
    },
  };
}

async function liveProfile(): Promise<string> {
  const root = join(dir, 'profile');
  await writeTree(root, {
    'Default/Local Storage/leveldb/000003.log': 'state',
    'Default/Local Storage/leveldb/LOCK': '',
    'Default/Cookies': 'cookies',
    'Default/Cookies-journal': 'j',
    lockfile: '',
  });
  return root;
}

describe('zipping a live profile', () => {
  it('leaves out the lock markers a running browser holds exclusively (Windows)', async () => {
    const root = await liveProfile();
    for (const at of ['open', 'read'] as const) {
      for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
        const entries = await zipEntries(
          root,
          liveFs({ [join('leveldb', 'LOCK')]: code, lockfile: code }, at),
        );
        expect(Object.keys(entries).sort()).toEqual([
          'Default/Cookies',
          'Default/Cookies-journal',
          'Default/Local Storage/leveldb/000003.log',
        ]);
      }
    }
    expect([...PROFILE_LOCK_FILES].sort()).toEqual(['LOCK', 'lockfile']);
  });

  it('leaves out a file that vanished between the listing and the read', async () => {
    const root = await liveProfile();
    const files = await zipEntries(root, liveFs({ 'Cookies-journal': 'ENOENT' }));
    expect(Object.keys(files)).not.toContain('Default/Cookies-journal');
    expect(new TextDecoder().decode(files['Default/Cookies'])).toBe('cookies');
  });

  it('fails on a locked data file (PROFILE_FILE_LOCKED) or any other read error: a snapshot never silently misses login data', async () => {
    const root = await liveProfile();
    const target = join(dir, 'out.zip');
    for (const at of ['open', 'read'] as const) {
      for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
        const locked = await zipDirectoryToFile(
          root,
          target,
          liveFs({ [join('Default', 'Cookies')]: code }, at),
        ).catch((err: unknown) => err);
        expect(isAppError(locked, 'PROFILE_FILE_LOCKED')).toBe(true);
        expect(isAppError(locked) && locked.details).toEqual({ file: 'Default/Cookies' });
      }
    }
    await expect(
      zipDirectoryToFile(root, target, liveFs({ [join('leveldb', 'LOCK')]: 'EIO' })),
    ).rejects.toMatchObject({ code: 'EIO' });
    await expect(
      zipDirectoryToFile(root, target, {
        ...fs,
        openRead: async () => Promise.reject(new Error('no code')),
      }),
    ).rejects.toThrow('no code');
    expect(await readdir(dir)).toEqual(['profile']);
  });
});

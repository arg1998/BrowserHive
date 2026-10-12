/** @module app/auth-states/zip.test — zip round trip, the zip-slip guard, and live-profile reads (vanished files, held lock markers). */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { createNodeAuthStateFs } from './store.ts';
import { PROFILE_LOCK_FILES, unzipToDirectory, type ZipFs, zipDirectory } from './zip.ts';

let dir: string;
const fs = createNodeAuthStateFs();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bh-zip-'));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe('profile zips', () => {
  it('round-trips nested regular files', async () => {
    await fs.mkdir(join(dir, 'src', 'a', 'b'));
    await fs.writeFile(join(dir, 'src', 'a', 'b', 'f.txt'), 'hello');
    const archive = await zipDirectory(join(dir, 'src'), fs);
    await unzipToDirectory(archive, join(dir, 'out'), fs);
    expect(await readFile(join(dir, 'out', 'a', 'b', 'f.txt'), 'utf8')).toBe('hello');
  });

  it('refuses an entry that escapes the destination (zip-slip)', async () => {
    const evil = zipSync({ '../escape.txt': new TextEncoder().encode('x') });
    try {
      await unzipToDirectory(evil, join(dir, 'out'), fs);
      throw new Error('expected PATH_NOT_ALLOWED');
    } catch (err) {
      expect(isAppError(err, 'PATH_NOT_ALLOWED')).toBe(true);
    }
    expect(await readFile(join(dir, 'escape.txt')).catch(() => null)).toBeNull();
  });
});

/** A real tree, with `readFile` failing for chosen relative paths the way a live browser makes it. */
function liveFs(failures: Readonly<Record<string, string>>): ZipFs {
  return {
    ...fs,
    readFile: async (path) => {
      for (const [suffix, code] of Object.entries(failures)) {
        if (path.endsWith(suffix)) throw Object.assign(new Error(`${code}: read`), { code });
      }
      return fs.readFile(path);
    },
  };
}

async function liveProfile(): Promise<string> {
  const root = join(dir, 'profile');
  await fs.mkdir(join(root, 'Default', 'Local Storage', 'leveldb'));
  await fs.writeFile(join(root, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'state');
  await fs.writeFile(join(root, 'Default', 'Local Storage', 'leveldb', 'LOCK'), '');
  await fs.writeFile(join(root, 'Default', 'Cookies'), 'cookies');
  await fs.writeFile(join(root, 'Default', 'Cookies-journal'), 'j');
  await fs.writeFile(join(root, 'lockfile'), '');
  return root;
}

describe('zipping a live profile', () => {
  it('leaves out the lock markers a running browser holds exclusively (Windows)', async () => {
    const root = await liveProfile();
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const archive = await zipDirectory(
        root,
        liveFs({ [join('leveldb', 'LOCK')]: code, lockfile: code }),
      );
      expect(Object.keys(unzipSync(archive)).sort()).toEqual([
        'Default/Cookies',
        'Default/Cookies-journal',
        'Default/Local Storage/leveldb/000003.log',
      ]);
    }
    expect([...PROFILE_LOCK_FILES].sort()).toEqual(['LOCK', 'lockfile']);
  });

  it('leaves out a file that vanished between the listing and the read', async () => {
    const root = await liveProfile();
    const archive = await zipDirectory(root, liveFs({ 'Cookies-journal': 'ENOENT' }));
    const files = unzipSync(archive);
    expect(Object.keys(files)).not.toContain('Default/Cookies-journal');
    expect(new TextDecoder().decode(files['Default/Cookies'])).toBe('cookies');
  });

  it('fails on a locked data file (PROFILE_FILE_LOCKED) or any other read error: a snapshot never silently misses data', async () => {
    const root = await liveProfile();
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const locked = await zipDirectory(root, liveFs({ [join('Default', 'Cookies')]: code })).catch(
        (err: unknown) => err,
      );
      expect(isAppError(locked, 'PROFILE_FILE_LOCKED')).toBe(true);
      expect(isAppError(locked) && locked.details).toEqual({ file: 'Default/Cookies' });
    }
    await expect(
      zipDirectory(root, liveFs({ [join('leveldb', 'LOCK')]: 'EIO' })),
    ).rejects.toMatchObject({
      code: 'EIO',
    });
    await expect(
      zipDirectory(root, { ...fs, readFile: async () => Promise.reject(new Error('no code')) }),
    ).rejects.toThrow('no code');
  });
});

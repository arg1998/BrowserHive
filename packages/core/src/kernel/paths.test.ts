/** @module kernel/paths.test — sandbox containment, symlink escapes and zip-slip. */

import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isAppError } from './errors/app-error.ts';
import {
  isSafeZipEntry,
  isWithin,
  realpathAllowingMissing,
  resolveWithinRoots,
  resolveZipEntry,
} from './paths.ts';

/** The registry code of a rejected promise, or `'resolved'` when it did not reject. */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return isAppError(error) ? error.code : 'other';
  }
}

describe('isWithin', () => {
  it('accepts the root itself and descendants', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true);
  });

  it('rejects siblings, parents and prefix look-alikes', () => {
    expect(isWithin('/a/b', '/a/bc')).toBe(false);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/a/b/../c')).toBe(false);
  });
});

describe('realpathAllowingMissing', () => {
  it('canonicalises the existing prefix and re-appends the missing tail', async () => {
    const seen: string[] = [];
    const realpath = async (p: string): Promise<string> => {
      seen.push(p);
      if (p === '/real' || p === '/') return p;
      if (p === '/link') return '/real';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    expect(await realpathAllowingMissing('/link/new/file.png', realpath)).toBe(
      '/real/new/file.png',
    );
    expect(seen[0]).toBe('/link/new/file.png');
  });

  it('propagates non-ENOENT errors', async () => {
    const realpath = async (): Promise<string> => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    await expect(realpathAllowingMissing('/x', realpath)).rejects.toThrow('denied');
  });
});

describe('resolveWithinRoots (real filesystem)', () => {
  it('handles relative resolution, traversal and symlink escapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bh-paths-'));
    try {
      const root = join(dir, 'uploads');
      const outside = join(dir, 'outside');
      await mkdir(root);
      await mkdir(outside);
      await writeFile(join(outside, 'secret.txt'), 'x');
      await symlink(outside, join(root, 'escape'));

      expect(await resolveWithinRoots('shot.png', { roots: [root] })).toBe(
        join(await realpathAllowingMissing(root), 'shot.png'),
      );
      expect(await resolveWithinRoots(join(root, 'sub', 'file.txt'), { roots: [root] })).toBe(
        join(await realpathAllowingMissing(root), 'sub', 'file.txt'),
      );

      expect(
        await rejectionOf(resolveWithinRoots('../outside/secret.txt', { roots: [root] })),
      ).toBe('PATH_NOT_ALLOWED');
      expect(await rejectionOf(resolveWithinRoots('escape/secret.txt', { roots: [root] }))).toBe(
        'PATH_NOT_ALLOWED',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts any of several roots and reports them in details', async () => {
    const realpath = async (p: string): Promise<string> => {
      if (p === '/' || p === '/r1' || p === '/r2') return p;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    expect(await resolveWithinRoots('/r2/x.png', { roots: ['/r1', '/r2'], realpath })).toBe(
      '/r2/x.png',
    );
    try {
      await resolveWithinRoots('/r3/x.png', {
        roots: ['/r1', '/r2'],
        realpath,
        relativeHint: 'e.g. x.png',
      });
      throw new Error('unreachable');
    } catch (error) {
      expect(isAppError(error, 'PATH_NOT_ALLOWED')).toBe(true);
      if (isAppError(error, 'PATH_NOT_ALLOWED')) {
        expect(error.details).toEqual({ path: '/r3/x.png', roots: ['/r1', '/r2'] });
        expect(error.publicMessage).toBe("Path '/r3/x.png' is outside the allowed sandbox roots.");
        expect(error.message).toBe(
          "Path '/r3/x.png' is outside the allowed sandbox roots. Allowed roots: '/r1', '/r2'. Pass an absolute path under one of these, or a relative path (e.g. x.png).",
        );
      }
    }
  });
});

describe('zip-slip guard', () => {
  it('isSafeZipEntry', () => {
    for (const ok of ['a.txt', 'dir/a.txt', 'dir/./a.txt', 'Default/Cookies']) {
      expect(isSafeZipEntry(ok)).toBe(true);
    }
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'C:\\x', 'a\\b', 'a\0b', '..']) {
      expect(isSafeZipEntry(bad)).toBe(false);
    }
  });

  it('resolveZipEntry lands under the root or throws PATH_NOT_ALLOWED', () => {
    expect(resolveZipEntry('/root', 'dir/a.txt')).toBe(resolve('/root/dir/a.txt'));
    expect(() => resolveZipEntry('/root', '../a.txt')).toThrow();
    try {
      resolveZipEntry('/root', 'x/../../a.txt');
    } catch (error) {
      expect(isAppError(error, 'PATH_NOT_ALLOWED')).toBe(true);
    }
  });
});

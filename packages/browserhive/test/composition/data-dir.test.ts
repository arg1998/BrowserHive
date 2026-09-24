/** @module test/composition/data-dir — the D-24 layout is created 0700; chmod is best effort, mkdir is not. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppError } from '@browserhive/core/runtime';
import { DATA_SUBDIRS, type DataDirFs, ensureDataDir } from '../../src/composition/data-dir.ts';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bh-datadir-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Real mkdir, but every chmod is refused the way a CIFS share or some bind mounts refuse it. */
const chmodRefused: DataDirFs = {
  existsSync,
  mkdirSync,
  chmodSync() {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  },
};

describe('ensureDataDir (D-24)', () => {
  it('creates the root and every subdirectory', () => {
    const root = join(base, 'data');
    const layout = ensureDataDir(root);
    expect(layout.root).toBe(root);
    for (const name of DATA_SUBDIRS) expect(existsSync(join(root, name))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(root).mode & 0o777).toBe(0o700);
    }
  });

  it('keeps booting when chmod is refused, reporting each directory it could not narrow', () => {
    const root = join(base, 'share');
    const failed: string[] = [];
    const layout = ensureDataDir(root, {
      fs: chmodRefused,
      onChmodFailed: (dir) => failed.push(dir),
    });
    expect(layout.root).toBe(root);
    expect(failed).toEqual([root, ...DATA_SUBDIRS.map((name) => join(root, name))]);
  });

  it('leaves existing directories alone', () => {
    const root = join(base, 'existing');
    ensureDataDir(root);
    const failed: string[] = [];
    ensureDataDir(root, { fs: chmodRefused, onChmodFailed: (dir) => failed.push(dir) });
    expect(failed).toEqual([]);
  });

  it('is still fatal when a directory cannot be created', () => {
    const root = join(base, 'nope');
    const mkdirRefused: DataDirFs = {
      existsSync,
      mkdirSync() {
        throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
      },
      chmodSync() {
        // Never reached: mkdir fails first.
      },
    };
    let caught: unknown;
    try {
      ensureDataDir(root, { fs: mkdirRefused });
    } catch (err) {
      caught = err;
    }
    expect(isAppError(caught) && caught.code).toBe('DATA_DIR_UNWRITABLE');
  });
});

/** @module test/composition/lock-file.test — data-dir lock: atomic acquire, live-pid refusal, stale/garbage replacement, owner-only release. */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAppError } from '@browserhive/core/runtime';
import {
  acquireDataDirLock,
  lockPathFor,
  type PidProbe,
  readLiveLock,
  readLock,
} from '../../src/composition/index.ts';
import { tempDir } from './support.ts';

const alive = (pids: number[]): PidProbe => ({ isAlive: (pid) => pids.includes(pid) });

describe('data-dir lock', () => {
  let dir = tempDir();
  afterEach(() => {
    dir.cleanup();
    dir = tempDir();
  });
  afterAll(() => dir.cleanup());

  it('writes pid, owner and start time; release removes it once', () => {
    const lock = acquireDataDirLock({ dataDir: dir.path, owner: 'serve', now: 42, pid: 111 });
    expect(readLock(lock.path)).toEqual({ pid: 111, startedAt: 42, owner: 'serve' });
    expect(readLiveLock(dir.path, alive([111]))?.pid).toBe(111);
    lock.release();
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it('refuses while a live process holds it', () => {
    acquireDataDirLock({ dataDir: dir.path, owner: 'serve', now: 1, pid: 200 });
    try {
      acquireDataDirLock({
        dataDir: dir.path,
        owner: 'db migrate',
        now: 2,
        pid: 300,
        probe: alive([200]),
      });
      throw new Error('expected DATA_DIR_LOCKED');
    } catch (err) {
      expect(isAppError(err) && err.code).toBe('DATA_DIR_LOCKED');
      if (isAppError(err)) expect(err.details).toEqual({ path: dir.path, pid: 200 });
    }
  });

  it('replaces a stale lock (dead pid) and a garbage lock', () => {
    const path = lockPathFor(dir.path);
    writeFileSync(path, '{"pid": 999}');
    const lock = acquireDataDirLock({
      dataDir: dir.path,
      owner: 'serve',
      now: 3,
      pid: 5,
      probe: alive([]),
    });
    expect(readLock(path)?.pid).toBe(5);
    lock.release();
    writeFileSync(path, 'not a lock');
    expect(readLiveLock(dir.path, alive([5]))).toBeNull();
    const again = acquireDataDirLock({
      dataDir: dir.path,
      owner: 'serve',
      now: 4,
      pid: 6,
      probe: alive([]),
    });
    expect(readLock(path)?.pid).toBe(6);
    again.release();
  });

  it('accepts a bare pid and never removes a lock that another process re-took', () => {
    const path = lockPathFor(dir.path);
    const lock = acquireDataDirLock({ dataDir: dir.path, owner: 'serve', now: 1, pid: 7 });
    writeFileSync(path, '8\n');
    expect(readLock(path)).toEqual({ pid: 8, startedAt: null, owner: null });
    lock.release();
    expect(readFileSync(path, 'utf8')).toBe('8\n');
  });
});

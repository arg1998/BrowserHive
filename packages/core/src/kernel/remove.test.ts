/** @module kernel/remove.test — removeTree: real removal, transient-lock retries with backoff, budget, non-transient errors. */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTree, TRANSIENT_REMOVE_CODES } from './remove.ts';

function failing(codes: readonly (string | undefined)[]) {
  const calls: string[] = [];
  const waits: number[] = [];
  let i = 0;
  return {
    calls,
    waits,
    rm: async (path: string) => {
      calls.push(path);
      const code = codes[i++];
      if (code === undefined) return;
      throw Object.assign(new Error(`${code}: busy`), { code });
    },
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('removeTree', () => {
  it('removes a real directory tree, and a missing path is not an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bh-remove-'));
    await writeFile(join(dir, 'a.txt'), 'x');
    await removeTree(dir);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await removeTree(dir);
  });

  it('retries the transient lock errors with a linear backoff until the remove succeeds', async () => {
    const f = failing(['EBUSY', 'EPERM', 'ENOTEMPTY', undefined]);
    await removeTree('/data', { rm: f.rm, sleep: f.sleep, retryDelayMs: 10 });
    expect(f.calls).toEqual(['/data', '/data', '/data', '/data']);
    expect(f.waits).toEqual([10, 20, 30]);
  });

  it('gives up after the retry budget and rethrows the last error', async () => {
    const f = failing(['EBUSY', 'EBUSY', 'EBUSY']);
    await expect(
      removeTree('/data', { rm: f.rm, sleep: f.sleep, retries: 2 }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(f.calls).toHaveLength(3);
    expect(f.waits).toEqual([50, 100]);
  });

  it('throws other errors at once', async () => {
    for (const code of ['EINVAL', undefined]) {
      const calls: string[] = [];
      const error =
        code === undefined ? new Error('plain') : Object.assign(new Error(code), { code });
      await expect(
        removeTree('/data', {
          rm: async (p) => {
            calls.push(p);
            throw error;
          },
          sleep: async () => undefined,
        }),
      ).rejects.toBe(error);
      expect(calls).toHaveLength(1);
    }
  });

  it('treats the Windows lock and handle-exhaustion codes as transient', () => {
    expect([...TRANSIENT_REMOVE_CODES].sort()).toEqual([
      'EACCES',
      'EBUSY',
      'EMFILE',
      'ENFILE',
      'ENOTEMPTY',
      'EPERM',
    ]);
  });
});

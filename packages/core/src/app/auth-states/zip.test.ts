/** @module app/auth-states/zip.test — zip round trip and the zip-slip guard. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { createNodeAuthStateFs } from './store.ts';
import { unzipToDirectory, zipDirectory } from './zip.ts';

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

/** @module infra/auth/credentials-file.test — 0600 write under a 0700 dir; shred = zero-fill then unlink. */

import { describe, expect, it } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '../../../test/helpers/temp-dir.ts';
import { secret } from '../../kernel/secret.ts';
import { type CredentialsFs, createCredentialsFile } from './credentials-file.ts';

describe('credentials file (injected fs)', () => {
  it('writes password+newline with mode 0600 and shreds by zero-fill then unlink', async () => {
    const calls: string[] = [];
    let stored: Uint8Array | string | null = null;
    const fs: CredentialsFs = {
      async mkdir(path, options) {
        calls.push(`mkdir ${path} ${options.mode.toString(8)}`);
      },
      async writeFile(path, data, options) {
        calls.push(
          `write ${path} ${options.mode.toString(8)} ${typeof data === 'string' ? data.length : `zeros:${data.length}`}`,
        );
        stored = data;
      },
      async chmod(path, mode) {
        calls.push(`chmod ${path} ${mode.toString(8)}`);
      },
      async size() {
        return stored === null ? null : stored.length;
      },
      async unlink(path) {
        calls.push(`unlink ${path}`);
        stored = null;
      },
    };
    const file = createCredentialsFile({ dataDir: '/data', fs });
    expect(file.path).toBe('/data/admin/credentials.txt');
    expect(await file.exists()).toBe(false);
    await file.write(secret('pw'));
    expect(await file.exists()).toBe(true);
    await file.shred();
    await file.shred(); // missing file is not an error
    expect(await file.exists()).toBe(false);
    expect(calls).toEqual([
      'mkdir /data/admin 700',
      'write /data/admin/credentials.txt 600 3',
      'chmod /data/admin/credentials.txt 600',
      'write /data/admin/credentials.txt 600 zeros:3',
      'unlink /data/admin/credentials.txt',
    ]);
  });
});

describe('credentials file (real fs)', () => {
  it('creates admin/ 0700 and the file 0600 on disk, then removes it', async () => {
    await withTempDir(async (dir) => {
      const file = createCredentialsFile({ dataDir: dir });
      await file.write(secret('seed-password'));
      expect(await readFile(file.path, 'utf8')).toBe('seed-password\n');
      expect((await stat(file.path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, 'admin'))).mode & 0o777).toBe(0o700);
      await file.shred();
      expect(await file.exists()).toBe(false);
    });
  });
});

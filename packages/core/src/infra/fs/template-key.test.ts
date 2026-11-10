/** @module infra/fs/template-key.test — resolving the template key (spec 13 §2.4): configured key, key file created exclusively with mode 0600, never over existing files, and the O_EXCL race. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { templateKeyId } from '../../domain/templates/envelope.ts';
import {
  createKeyFile,
  decodeTemplateKey,
  resolveTemplateKeys,
  templateKeyPath,
} from './template-key.ts';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bh-tkey-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const none = async () => false;

describe('template key resolution (spec 13 §2.4)', () => {
  it('templateKey wins and no file is created', async () => {
    const keys = await resolveTemplateKeys({ dataDir: dir, configured: KEY_A, filesExist: none });
    expect(keys.source).toBe('config');
    expect(keys.current?.keyId).toBe(templateKeyId(Buffer.alloc(32, 1)));
    await expect(stat(templateKeyPath(dir))).rejects.toThrow();
  });

  it('creates admin/template.key with mode 0600 in a 0700 admin/ when no file exists', async () => {
    const keys = await resolveTemplateKeys({ dataDir: dir, filesExist: none });
    expect(keys.source).toBe('created');
    const info = await stat(templateKeyPath(dir));
    if (process.platform !== 'win32') {
      expect(info.mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, 'admin'))).mode & 0o777).toBe(0o700);
    }
    const again = await resolveTemplateKeys({ dataDir: dir, filesExist: none });
    expect(again.source).toBe('file');
    expect(again.current?.keyId).toBe(keys.current?.keyId);
  });

  it('never creates a key while encrypted files exist (TEMPLATE_KEY_MISSING)', async () => {
    const keys = await resolveTemplateKeys({ dataDir: dir, filesExist: async () => true });
    expect(keys.current).toBeNull();
    expect(keys.source).toBe('none');
    await expect(stat(templateKeyPath(dir))).rejects.toThrow();
  });

  it('creates the file exclusively: two racing creators end with one key', async () => {
    const path = templateKeyPath(dir);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createKeyFile(path, join(dir, 'admin'))),
    );
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    const resolved = await Promise.all(
      Array.from({ length: 4 }, () => resolveTemplateKeys({ dataDir: dir, filesExist: none })),
    );
    expect(new Set(resolved.map((r) => r.current?.keyId)).size).toBe(1);
    expect(resolved[0]?.current?.keyId).toBe(winners[0]?.keyId);
  });

  it('a racing resolver uses the file another process created', async () => {
    const all = await Promise.all(
      Array.from({ length: 6 }, () => resolveTemplateKeys({ dataDir: dir, filesExist: none })),
    );
    expect(new Set(all.map((k) => k.current?.keyId)).size).toBe(1);
    expect(all.filter((k) => k.source === 'created')).toHaveLength(1);
  });

  it('reports a key file that is not a key and never overwrites it', async () => {
    await createKeyFile(templateKeyPath(dir), join(dir, 'admin'));
    await writeFile(templateKeyPath(dir), 'not a key\n');
    const keys = await resolveTemplateKeys({ dataDir: dir, filesExist: none });
    expect(keys.current).toBeNull();
    expect(keys.problem).toContain('base64 of 32 bytes');
    expect(await readFile(templateKeyPath(dir), 'utf8')).toBe('not a key\n');
  });

  it('carries templateKeyPrevious read-only', async () => {
    const keys = await resolveTemplateKeys({
      dataDir: dir,
      configured: KEY_A,
      previous: KEY_B,
      filesExist: none,
    });
    expect(keys.previous?.keyId).toBe(templateKeyId(Buffer.alloc(32, 2)));
  });

  it('decodes standard and URL-safe base64 of exactly 32 bytes only', () => {
    expect(decodeTemplateKey(KEY_A)?.length).toBe(32);
    expect(decodeTemplateKey(KEY_A.replace(/\+/g, '-').replace(/\//g, '_'))?.length).toBe(32);
    expect(decodeTemplateKey(Buffer.alloc(31).toString('base64'))).toBeNull();
    expect(decodeTemplateKey('')).toBeNull();
  });
});

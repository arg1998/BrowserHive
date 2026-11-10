/** @module infra/fs/template-state-store.test — the encrypted state files on disk and `rekey` (spec 13 §2.4): modes, no clear text, swapped files, the previous key, interrupted and repeated rotation. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { templateKeyOf } from '../../domain/templates/envelope.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateStateFileRecord } from '../../ports/persistence/index.ts';
import type { TemplateState } from '../../ports/template-state.ts';
import { rekeyTemplateFiles } from './template-rekey.ts';
import { FileTemplateStateStore } from './template-state-store.ts';

const OLD = templateKeyOf(new Uint8Array(32).fill(1));
const NEW = templateKeyOf(new Uint8Array(32).fill(2));
const T1 = 'tp-aaaaaaaaaa';
const T2 = 'tp-bbbbbbbbbb';
const STATE: TemplateState = {
  cookies: [
    {
      name: 'sentinel_cookie_name',
      value: 'sentinel-cookie-value',
      domain: '.site-a.test',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [{ origin: 'https://site-a.test', localStorage: [{ name: 'auth', value: 'tok' }] }],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bh-tstate-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAppError(err)) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('FileTemplateStateStore (spec 13 §2.4)', () => {
  it('writes 0600 files that hold no cookie name or value in clear text and read back', async () => {
    const store = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: NEW, previous: null },
    });
    const file = await store.write(T1, 1, STATE);
    const path = join(dir, T1, 'versions', 'v1.state.enc');
    const bytes = await readFile(path);
    expect(file.sizeBytes).toBe(bytes.length);
    expect(file.keyId).toBe(NEW.keyId);
    expect(bytes.includes(Buffer.from('sentinel_cookie_name'))).toBe(false);
    expect(bytes.includes(Buffer.from('sentinel-cookie-value'))).toBe(false);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.read(T1, 1)).toEqual(STATE);
    expect(await readdir(join(dir, T1, 'versions'))).toEqual(['v1.state.enc']);
  });

  it('refuses a file swapped between slots or templates', async () => {
    const store = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: NEW, previous: null },
    });
    await store.write(T1, 1, STATE);
    await store.write(T1, 2, STATE);
    const v1 = await readFile(join(dir, T1, 'versions', 'v1.state.enc'));
    await writeFile(join(dir, T1, 'versions', 'v2.state.enc'), v1);
    expect(await code(store.read(T1, 2))).toBe('TEMPLATE_VERSION_UNREADABLE');
    await store.write(T2, 1, STATE);
    await writeFile(join(dir, T2, 'versions', 'v1.state.enc'), v1.subarray(0));
    // The same bytes under another template: AAD differs.
    await writeFile(join(dir, T2, 'versions', 'latest.state.enc'), v1);
    expect(await code(store.read(T2, 'latest'))).toBe('TEMPLATE_VERSION_UNREADABLE');
  });

  it('reads old files with templateKeyPrevious, never writes with it', async () => {
    const old = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: OLD, previous: null },
    });
    await old.write(T1, 1, STATE);
    const rotated = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: NEW, previous: OLD },
    });
    expect(await rotated.read(T1, 1)).toEqual(STATE);
    expect((await rotated.write(T1, 2, STATE)).keyId).toBe(NEW.keyId);
    const noPrevious = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: NEW, previous: null },
    });
    expect(await code(noPrevious.read(T1, 1))).toBe('TEMPLATE_VERSION_UNREADABLE');
  });

  it('refuses to write without a key and lists files with their key ids', async () => {
    const keyless = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: null, previous: null },
    });
    expect(await code(keyless.write(T1, 'latest', STATE))).toBe('TEMPLATE_VERSION_UNREADABLE');
    const store = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: NEW, previous: null },
    });
    await store.write(T1, 'latest', STATE);
    await store.write(T1, 3, STATE);
    await writeFile(join(dir, T1, 'versions', 'v4.state.enc.tmp'), 'partial');
    const files = await store.files(T1);
    expect(files.map((f) => f.slot).sort()).toEqual([3, 'latest']);
    expect(files.every((f) => f.keyId === NEW.keyId)).toBe(true);
    expect(await store.templatesWithFiles()).toEqual([T1]);
    expect(await store.removeTemporaries(T1)).toBe(1);
    await store.remove(T1, 3);
    expect((await store.files(T1)).map((f) => f.slot)).toEqual(['latest']);
  });
});

describe('templates rekey (spec 13 §2.4 rotation)', () => {
  async function seed(): Promise<Map<string, TemplateStateFileRecord>> {
    const old = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: OLD, previous: null },
    });
    const rows = new Map<string, TemplateStateFileRecord>();
    for (const [t, slot] of [
      [T1, 1],
      [T1, 2],
      [T1, 'latest'],
      [T2, 1],
    ] as const) {
      const file = await old.write(t, slot, STATE);
      if (slot !== 'latest') rows.set(`${t} ${slot}`, file);
    }
    return rows;
  }

  it('re-encrypts every file with the current key and updates the rows', async () => {
    const rows = await seed();
    const store = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: NEW, previous: null },
    });
    const result = await rekeyTemplateFiles({
      store,
      current: NEW,
      old: OLD,
      updateRow: async (t, v, file) => void rows.set(`${t} ${v}`, file),
    });
    expect(result).toEqual({ rewritten: 4, skipped: 0, failed: [] });
    for (const file of await store.files(T1)) expect(file.keyId).toBe(NEW.keyId);
    expect([...rows.values()].every((r) => r.keyId === NEW.keyId)).toBe(true);
    expect(await store.read(T1, 'latest')).toEqual(STATE);
  });

  it('is repeatable after an interruption: done files are skipped, their rows reconciled', async () => {
    const rows = await seed();
    const store = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: NEW, previous: null },
    });
    // Interrupted: the first file was renamed but its row never moved, and a .tmp is left behind.
    await store.writeWith(T1, 1, STATE, NEW);
    await writeFile(join(dir, T1, 'versions', 'v2.state.enc.tmp'), 'partial');
    const result = await rekeyTemplateFiles({
      store,
      current: NEW,
      old: OLD,
      updateRow: async (t, v, file) => void rows.set(`${t} ${v}`, file),
    });
    expect(result.rewritten).toBe(3);
    expect(result.skipped).toBe(1);
    expect(rows.get(`${T1} 1`)?.keyId).toBe(NEW.keyId);
    const again = await rekeyTemplateFiles({
      store,
      current: NEW,
      old: OLD,
      updateRow: async (t, v, file) => void rows.set(`${t} ${v}`, file),
    });
    expect(again).toEqual({ rewritten: 0, skipped: 4, failed: [] });
    expect(await readdir(join(dir, T1, 'versions'))).not.toContain('v2.state.enc.tmp');
  });

  it('reports a file no key opens and keeps going', async () => {
    await seed();
    const stranger = templateKeyOf(new Uint8Array(32).fill(3));
    const store = new FileTemplateStateStore({
      templatesDir: dir,
      keys: { current: NEW, previous: null },
    });
    const result = await rekeyTemplateFiles({
      store,
      current: NEW,
      old: stranger,
      updateRow: async () => undefined,
    });
    expect(result.rewritten).toBe(0);
    expect(result.failed).toHaveLength(4);
  });
});

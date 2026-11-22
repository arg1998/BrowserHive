/** @module infra/site-packs/sources.test — the bundled source (source folder and built index), the local source's skips, and the approved-copy cache with its name checks (spec 13 §9.8, §10.5, §10.9, D-67). */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeDirs,
  packBytes,
  packSha,
  removeDirs,
  type SitePackDirs,
  sitePack,
  writePack,
} from '../../../test/helpers/site-pack-kit.ts';
import { BundledPackSource } from './bundled-source.ts';
import { LocalPackSource } from './local-source.ts';
import { createLocalPackWriter, createSitePackCache } from './pack-cache.ts';

let dirs: SitePackDirs;
afterEach(() => removeDirs(dirs));
const signal = new AbortController().signal;

async function catalog(source: BundledPackSource | LocalPackSource) {
  const result = await source.load(signal);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('BundledPackSource', () => {
  it('reads <id>.json files from a source folder; a missing folder is empty', async () => {
    dirs = makeDirs();
    writePack(dirs.bundled, sitePack('site-a.test', 1));
    writeFileSync(join(dirs.bundled, 'wrong.test.json'), packBytes(sitePack('site-b.test', 1)));
    const found = await catalog(new BundledPackSource({ dir: dirs.bundled, release: '0.3.0' }));
    expect(found.packs.map((p) => [p.pack.id, p.origin])).toEqual([['site-a.test', '0.3.0']]);
    expect(found.skipped.map((s) => s.reason)).toEqual(['id_mismatch']);
    const none = await catalog(new BundledPackSource({ dir: join(dirs.root, 'x'), release: '1' }));
    expect(none.packs).toEqual([]);
  });

  it('skips a pack the binary is too old for', async () => {
    dirs = makeDirs();
    writePack(dirs.bundled, sitePack('site-a.test', 1, { min_client: '9.0.0' }));
    const found = await catalog(new BundledPackSource({ dir: dirs.bundled, release: '0.3.0' }));
    expect(found.skipped.map((s) => s.reason)).toEqual(['min_client']);
  });

  it('reads a build through index.json and refuses files that do not match it', async () => {
    dirs = makeDirs();
    const a = sitePack('site-a.test', 1);
    const b = sitePack('site-b.test', 1);
    writePack(join(dirs.bundled, 'packs'), a);
    writePack(join(dirs.bundled, 'packs'), b);
    const entry = (p: typeof a, sha: string) => ({
      id: p.id,
      version: 1,
      sha256: sha,
      size: packBytes(p).byteLength,
      path: `packs/${p.id}.json`,
    });
    writeFileSync(
      join(dirs.bundled, 'index.json'),
      JSON.stringify({
        release: '0.3.0',
        built_at: 1_700_000_000_000,
        packs: [entry(a, packSha(a)), entry(b, '0'.repeat(64))],
      }),
    );
    const source = new BundledPackSource({ dir: dirs.bundled, release: '0.3.0' });
    const found = await catalog(source);
    expect(found.packs.map((p) => p.pack.id)).toEqual(['site-a.test']);
    expect(found.skipped.map((s) => [s.packId, s.reason])).toEqual([['site-b.test', 'invalid']]);
    expect(source.builtAt).toBe(1_700_000_000_000);
  });
});

describe('LocalPackSource', () => {
  it('loads unsigned files, skips oversized ones and lists signed layouts for the registry client', async () => {
    dirs = makeDirs();
    writePack(dirs.local, sitePack('site-a.test', 1));
    writeFileSync(join(dirs.local, 'big.test.json'), 'x'.repeat(70 * 1024));
    writeFileSync(join(dirs.local, 'notes.txt'), 'ignored');
    mkdirSync(join(dirs.local, 'layout'));
    const found = await catalog(new LocalPackSource({ dir: dirs.local, binaryVersion: '0.3.0' }));
    expect(found.packs.map((p) => [p.pack.id, p.origin])).toEqual([
      ['site-a.test', join(dirs.local, 'site-a.test.json')],
    ]);
    expect(found.skipped.map((s) => s.reason)).toEqual(['too_large']);
    expect(found.signedLayouts).toBe(1);
    expect(found.layouts).toEqual([join(dirs.local, 'layout')]);
  });
});

describe('the approved-copy cache', () => {
  it('stores byte-exact copies under <source>/<id>/<sha256>.json and refuses unsafe names', async () => {
    dirs = makeDirs();
    const cache = createSitePackCache(dirs.cache);
    const bytes = packBytes(sitePack('site-a.test', 1));
    const sha = packSha(sitePack('site-a.test', 1));
    await cache.put('bundled', 'site-a.test', sha, bytes);
    await cache.put('bundled', 'site-a.test', sha, bytes);
    expect(await cache.get('bundled', 'site-a.test', sha)).toEqual(bytes);
    expect(readFileSync(join(dirs.cache, 'bundled', 'site-a.test', `${sha}.json`))).toEqual(
      Buffer.from(bytes),
    );
    expect(await cache.get('local', 'site-a.test', sha)).toBeNull();
    expect(await cache.get('bundled', '../etc', sha)).toBeNull();
    await expect(cache.put('bundled', '../x', sha, bytes)).rejects.toThrow();
    await expect(cache.put('bundled', 'site-a.test', 'nope', bytes)).rejects.toThrow();
  });

  it('the import writer writes <dir>/<id>.json only for safe ids', async () => {
    dirs = makeDirs();
    const writer = createLocalPackWriter(dirs.local);
    const path = await writer.write('site-a.test', new TextEncoder().encode('{}'));
    expect(path).toBe(join(dirs.local, 'site-a.test.json'));
    await expect(writer.write('../../evil', new Uint8Array())).rejects.toThrow();
  });
});

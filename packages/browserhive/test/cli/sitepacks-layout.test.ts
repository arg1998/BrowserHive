/** @module test/cli/sitepacks-layout.test — `sitepacks export <dir>` and `sitepacks import <dir>` for signed registry layouts (spec 13 §10.1, §10.5, §11.5): export writes the server's files byte for byte and refuses unsafe targets and paths; import reads exact bytes (review #97 D80) and sends the four signed files and the listed pack files, base64 by path, with the folder's name; export then import round-trips the bytes. Layouts are signed at run time with throwaway keys (registry-kit). */
import { describe, expect, it } from 'bun:test';
import type { SitePackExportResponse, SitePackImportResponse } from '@browserhive/contracts/http';
import { buildLayout } from '@browserhive/core/test/registry-kit';
import { MemoryFs } from './helpers.ts';
import { fakePackServer, problem, run, URL_FLAGS, writes } from './sitepacks-fakes.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const OUT = '/work/export';

function pack(id: string, version: number) {
  return {
    schema: 1 as const,
    id,
    version,
    min_client: '0.1.0',
    title: `Site ${id}`,
    domains: [id],
    sign_in: { url: { host: `www.${id}`, path: '/login' }, human_only: false },
    signed_in: {
      probe: { host: `www.${id}`, path: '/account' },
      kind: 'redirect' as const,
      signed_out_redirects: [`www.${id}/login*`],
    },
    write_policy: { default: 'confirm' as const, stance: 'prohibited' as const },
  };
}

const layout = buildLayout({ now: NOW, packs: [pack('site-a.test', 2), pack('site-b.test', 5)] });

function base64Files(files: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    [...files].map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]),
  );
}

function exportBody(files: Record<string, string> = base64Files(layout.files)) {
  const body: SitePackExportResponse = {
    files,
    index_version: 10,
    keys_version: 1,
    packs: 2,
    missing: [],
  };
  return body;
}

function exportServer(body: unknown = exportBody()) {
  const server = fakePackServer();
  server.routes = (method, path) =>
    method === 'GET' && path === '/api/v1/site-packs/export' ? [200, body] : undefined;
  return server;
}

function bytesAt(fs: MemoryFs, path: string): Promise<Uint8Array> {
  return fs.readBytes(path);
}

describe('sitepacks export <dir>', () => {
  it('writes every file of the layout byte for byte into a new folder', async () => {
    const fs = new MemoryFs();
    const result = await run(exportServer(), ['export', OUT, ...URL_FLAGS], { fs });
    expect(result.code).toBe(0);
    for (const [path, bytes] of layout.files) {
      expect(await bytesAt(fs, `${OUT}/${path}`)).toEqual(bytes);
    }
    expect(result.stdout).toContain(`exported the signed layout to ${OUT}`);
    expect(result.stdout).toContain('index v10 · keys v1 · 2 pack file(s)');
    expect(result.stdout).toContain(`browserhive sitepacks import ${OUT}`);
    // The signatures are written last: a folder cut short holds no signed index.
    const written = fs.writes.filter((w) => w.startsWith('write '));
    expect(written.slice(-2)).toEqual([
      `write ${OUT}/keys.json.sig`,
      `write ${OUT}/index.json.sig`,
    ]);
  });

  it('keeps bytes that are not UTF-8 exactly (no text round trip)', async () => {
    const odd = new Uint8Array([0xff, 0xfe, 0x00, 0x7b, 0xe9]);
    const files = {
      ...base64Files(layout.files),
      'index.json': Buffer.from(odd).toString('base64'),
    };
    const fs = new MemoryFs();
    const result = await run(exportServer(exportBody(files)), ['export', OUT, ...URL_FLAGS], {
      fs,
    });
    expect(result.code).toBe(0);
    expect(await bytesAt(fs, `${OUT}/index.json`)).toEqual(odd);
  });

  it('--json lists what it wrote, not the file contents', async () => {
    const result = await run(exportServer(), ['export', OUT, '--json', ...URL_FLAGS], {
      fs: new MemoryFs(),
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { written: string[]; index_version: number };
    expect(parsed.index_version).toBe(10);
    expect(parsed.written).toHaveLength(layout.files.size);
    expect(result.stdout).not.toContain(
      Buffer.from(layout.files.get('index.json') ?? []).toString('base64'),
    );
  });

  it('refuses a non-empty folder that holds no layout, before asking the server', async () => {
    const fs = new MemoryFs({ [`${OUT}/notes.txt`]: 'mine' });
    const server = exportServer();
    const result = await run(server, ['export', OUT, ...URL_FLAGS], { fs });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not empty and holds no signed layout');
    expect(server.calls).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  it('overwrites a folder that already holds a layout (only its layout files)', async () => {
    const fs = new MemoryFs({
      [`${OUT}/keys.json`]: 'old',
      [`${OUT}/README.txt`]: 'kept',
    });
    const result = await run(exportServer(), ['export', OUT, ...URL_FLAGS], { fs });
    expect(result.code).toBe(0);
    expect(await bytesAt(fs, `${OUT}/keys.json`)).toEqual(
      layout.files.get('keys.json') ?? new Uint8Array(),
    );
    expect(await fs.readFile(`${OUT}/README.txt`)).toBe('kept');
  });

  it.each([
    ['a path outside the layout', { '../escape.json': 'e30=' }],
    ['a pack path with a dot segment', { 'packs/../x.json': 'e30=' }],
    ['a pack id that is not a domain', { [`packs/not_a_domain/${'0'.repeat(64)}.json`]: 'e30=' }],
    ['base64 that does not round-trip', { 'keys.json': 'e30' }],
  ])('refuses %s and writes nothing', async (_name, extra) => {
    const fs = new MemoryFs();
    const files = { ...base64Files(layout.files), ...extra };
    const result = await run(exportServer(exportBody(files)), ['export', OUT, ...URL_FLAGS], {
      fs,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('nothing was written');
    expect(fs.writes).toEqual([]);
  });

  it('refuses an export that lacks a signed file', async () => {
    const files = base64Files(layout.files);
    delete files['index.json.sig'];
    const fs = new MemoryFs();
    const result = await run(exportServer(exportBody(files)), ['export', OUT, ...URL_FLAGS], {
      fs,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('lacks index.json.sig');
    expect(fs.writes).toEqual([]);
  });

  it('names the listed versions it does not hold and exits 0 (review #100 L6)', async () => {
    const body = {
      ...exportBody(),
      missing: [
        { pack_id: 'facebook.com', version: 3 },
        { pack_id: 'x.com', version: 7 },
      ],
    };
    const fs = new MemoryFs();
    const result = await run(exportServer(body), ['export', OUT, ...URL_FLAGS], { fs });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('2 listed version(s) not held, so not in the folder');
    expect(result.stdout).toContain(
      'facebook.com v3, x.com v7; run browserhive sitepacks download --all first to include them',
    );
    const json = await run(exportServer(body), ['export', `${OUT}2`, '--json', ...URL_FLAGS], {
      fs,
    });
    expect((JSON.parse(json.stdout) as { missing: unknown[] }).missing).toHaveLength(2);
  });

  it('nothing held yet: the server refusal is printed, exit 1', async () => {
    const server = fakePackServer();
    server.routes = () => [
      409,
      problem(409, 'SITE_PACKS_REGISTRY_UNAVAILABLE', 'No registry index has verified yet.'),
    ];
    const result = await run(server, ['export', OUT, ...URL_FLAGS], { fs: new MemoryFs() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[SITE_PACKS_REGISTRY_UNAVAILABLE]');
  });
});

function importServer(seen: unknown[], answer?: SitePackImportResponse) {
  const server = fakePackServer();
  server.routes = (method, path, body) => {
    if (method === 'POST' && path === '/api/v1/site-packs/import') {
      seen.push(body);
      return [
        200,
        answer ?? {
          imported: [
            { pack_id: 'site-a.test', version: 2, state: 'downloaded', sha256: 'a'.repeat(64) },
            { pack_id: 'site-b.test', version: 5, state: 'available', sha256: 'b'.repeat(64) },
          ],
          layout: {
            outcome: 'updated',
            index_version: 10,
            keys_version: 1,
            signed_by: layout.online.keyId,
          },
        },
      ];
    }
    return undefined;
  };
  return server;
}

function layoutFs(dir: string, files: ReadonlyMap<string, Uint8Array> = layout.files): MemoryFs {
  const fs = new MemoryFs();
  for (const [path, bytes] of files) fs.put(`${dir}/${path}`, bytes);
  return fs;
}

describe('sitepacks import <dir> (a signed layout)', () => {
  it('export then import sends the exact bytes back, with the folder name', async () => {
    const fs = new MemoryFs();
    expect((await run(exportServer(), ['export', OUT, ...URL_FLAGS], { fs })).code).toBe(0);
    const seen: unknown[] = [];
    const server = importServer(seen);
    const result = await run(server, ['import', OUT, ...URL_FLAGS], { fs });
    expect(result.code).toBe(0);
    expect(writes(server)).toEqual(['POST /api/v1/site-packs/import']);
    const body = seen[0] as { files: Record<string, string>; name: string };
    expect(body.name).toBe('export');
    expect(Object.keys(body.files).sort()).toEqual([...layout.files.keys()].sort());
    for (const [path, bytes] of layout.files) {
      expect(Buffer.from(body.files[path] ?? '', 'base64').equals(bytes)).toBe(true);
    }
    expect(result.stdout).toContain(`imported the signed layout ${OUT}`);
    expect(result.stdout).toContain(
      `index v10 (now held) · keys v1 · signed by ${layout.online.keyId}`,
    );
    expect(result.stdout).toMatch(/site-a\.test\s+v2\s+queued for review \(Downloaded\)/);
    expect(result.stdout).toMatch(/site-b\.test\s+v5\s+listed, file not in the layout/);
    expect(result.stdout).toContain('browserhive sitepacks diff <pack> --to <version>');
  });

  it('sends only listed pack files; counts the absent and the unlisted ones', async () => {
    const files = new Map(layout.files);
    const [first] = [...files.keys()].filter((p) => p.startsWith('packs/site-b.test/'));
    if (first !== undefined) files.delete(first);
    const fs = layoutFs('/work/l', files);
    fs.put(`/work/l/packs/site-a.test/${'c'.repeat(64)}.json`, '{}');
    const seen: unknown[] = [];
    const result = await run(importServer(seen), ['import', '/work/l', ...URL_FLAGS], { fs });
    expect(result.code).toBe(0);
    const sent = Object.keys((seen[0] as { files: Record<string, string> }).files);
    expect(sent).toHaveLength(layout.files.size - 1);
    expect(sent.some((p) => p.includes('c'.repeat(64)))).toBe(false);
    expect(result.stdout).toContain('1 listed version(s) have no file in the folder');
    expect(result.stdout).toContain(
      '1 file(s) under packs/ are not in the index and were not sent',
    );
  });

  it('--json prints the server answer; a refused file warns', async () => {
    const seen: unknown[] = [];
    const answer: SitePackImportResponse = {
      imported: [{ pack_id: 'site-a.test', version: 2, state: 'refused', sha256: 'a'.repeat(64) }],
      layout: { outcome: 'not_modified', index_version: 10, keys_version: 1, signed_by: 'x' },
    };
    const json = await run(
      importServer(seen, answer),
      ['import', '/work/l', '--json', ...URL_FLAGS],
      {
        fs: layoutFs('/work/l'),
      },
    );
    expect(json.code).toBe(0);
    expect((JSON.parse(json.stdout) as SitePackImportResponse).layout?.outcome).toBe(
      'not_modified',
    );
    const text = await run(importServer([], answer), ['import', '/work/l', ...URL_FLAGS], {
      fs: layoutFs('/work/l'),
    });
    expect(text.stdout).toContain('already held');
    expect(text.stdout).toContain('1 pack file(s) refused');
  });

  it('refuses locally a folder missing a signed file, or with an index that is not one', async () => {
    const missing = new Map(layout.files);
    missing.delete('keys.json.sig');
    const server = importServer([]);
    const noSig = await run(server, ['import', '/work/l', ...URL_FLAGS], {
      fs: layoutFs('/work/l', missing),
    });
    expect(noSig.code).toBe(1);
    expect(noSig.stderr).toContain('holds no readable keys.json.sig');
    const bad = new Map(layout.files);
    bad.set('index.json', new TextEncoder().encode('{"schema":2}'));
    const notIndex = await run(server, ['import', '/work/l', ...URL_FLAGS], {
      fs: layoutFs('/work/l', bad),
    });
    expect(notIndex.code).toBe(1);
    expect(notIndex.stderr).toContain('is not a registry index');
    expect(server.calls).toEqual([]);
  });

  it('refuses a layout too large for one import and points to the local folder', async () => {
    const big = new Map(layout.files);
    // An unlisted big file is not sent; a big listed one is: grow keys.json instead.
    big.set('keys.json', new Uint8Array(1024 * 1024 - 10).fill(0x20));
    const server = importServer([]);
    const result = await run(server, ['import', '/work/l', ...URL_FLAGS], {
      fs: layoutFs('/work/l', big),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Copy the folder into sitePacksDir instead');
    expect(server.calls).toEqual([]);
  });

  it('states: revoked by the publisher; a downloaded version of an unfollowed pack says how to review it; counts match the table (review #100 M7, L8)', async () => {
    const answer: SitePackImportResponse = {
      imported: [
        { pack_id: 'github.com', version: 3, state: 'revoked', sha256: 'a'.repeat(64) },
        {
          pack_id: 'reddit.com',
          version: 4,
          state: 'downloaded',
          sha256: 'b'.repeat(64),
          followed: false,
        },
        { pack_id: 'facebook.com', version: 3, state: 'available', sha256: 'c'.repeat(64) },
      ],
      layout: { outcome: 'updated', index_version: 15, keys_version: 1, signed_by: 'x' },
    };
    const result = await run(importServer([], answer), ['import', '/work/l', ...URL_FLAGS], {
      fs: layoutFs('/work/l'),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/github\.com\s+v3\s+revoked by the publisher/);
    expect(result.stdout).toMatch(
      /reddit\.com\s+v4\s+downloaded; browserhive sitepacks follow reddit\.com on to review it/,
    );
    expect(result.stdout).toContain('1 listed version(s) have no file in the folder');
    // Nothing followed waits: no "review them" hint pointing at an empty Updates list.
    expect(result.stdout).not.toContain('Review them');
  });

  it('a layout signed by an untrusted root: a full stop and the verify hint for the folder (review #100 L8)', async () => {
    const server = fakePackServer();
    server.routes = () => [
      400,
      {
        ...(problem(
          400,
          'SITE_PACK_INVALID',
          'keys.json: unknown_key (signed by no trusted key',
        ) as object),
        hint: 'Fix the listed fields; `browserhive sitepacks verify <file>` shows them.',
      },
    ];
    const result = await run(server, ['import', '/work/l', ...URL_FLAGS], {
      fs: layoutFs('/work/l'),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'the signed layout /work/l was not imported: [SITE_PACK_INVALID] keys.json: unknown_key (signed by no trusted key.',
    );
    expect(result.stderr).toContain('Check it offline: browserhive sitepacks verify /work/l');
    expect(result.stderr).not.toContain('Fix the listed fields');
  });

  it('the server refusal (a layout this release does not trust) exits 1', async () => {
    const server = fakePackServer();
    server.routes = () => [
      400,
      problem(400, 'SITE_PACK_INVALID', 'keys.json: unknown_key (signed by no pinned root)'),
    ];
    const result = await run(server, ['import', '/work/l', ...URL_FLAGS], {
      fs: layoutFs('/work/l'),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown_key');
  });
});

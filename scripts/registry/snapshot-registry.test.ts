/** @module scripts/registry/snapshot-registry.test — the release snapshot (spec 13 §10.9) against a local `Bun.serve` registry holding a layout signed at run time with throwaway keys (registry-kit), never browserhive.ai: a verified layout is written byte for byte with only the listed files fetched and the client's request hygiene (User-Agent `BrowserHive`, no query, no cookie); a tampered pack file, a tampered index, a redirect, an oversized file, an unlisted signer and a build that pins no root keys are refused with nothing written; a target that is not a layout is never replaced; the CLI entry exits 1 with the message.
 *
 * Timeouts: one case starts a Bun child process (it loads core); Windows starts processes slowly, so
 * that case gets 60 s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PINNED_TRUST_ROOT, trustsNothing } from '@browserhive/core/server';
import {
  buildLayout,
  canonical,
  sigOf,
  type TestLayout,
  testKey,
} from '@browserhive/core/test/registry-kit';
import { CEREMONY_MESSAGE, snapshotRegistry } from '../snapshot-registry.ts';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const REPO = resolve(import.meta.dir, '..', '..');

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

interface Served {
  files: Map<string, Uint8Array>;
  /** Paths answered with a redirect. */
  redirects: Set<string>;
  requests: { path: string; search: string; agent: string | null; cookie: string | null }[];
}

let work: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let rootFile: string;
const layout: TestLayout = buildLayout({
  now: NOW,
  packs: [pack('site-a.test', 2), pack('site-b.test', 5)],
});
const served: Served = { files: new Map(), redirects: new Set(), requests: [] };

function serve(files: ReadonlyMap<string, Uint8Array> = layout.files): void {
  served.files = new Map(files);
  served.redirects = new Set();
  served.requests = [];
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'bh-snapshot-'));
  rootFile = join(work, 'root-1.pub');
  writeFileSync(
    rootFile,
    JSON.stringify({ key_id: layout.root.keyId, public_key: layout.root.publicKey }),
  );
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      served.requests.push({
        path: url.pathname,
        search: url.search,
        agent: request.headers.get('user-agent'),
        cookie: request.headers.get('cookie'),
      });
      const path = url.pathname.replace(/^\/registry\/v1\//, '');
      if (served.redirects.has(path)) {
        return new Response(null, { status: 302, headers: { location: '/elsewhere' } });
      }
      const bytes = served.files.get(path);
      return bytes === undefined ? new Response('not found', { status: 404 }) : new Response(bytes);
    },
  });
  base = `http://127.0.0.1:${server.port}/registry/v1/`;
});

afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

function outDir(name: string): string {
  return join(work, name, 'registry', 'v1');
}

const snapshot = (out: string, extra: string[] = []) =>
  snapshotRegistry(['--url', base, '--out', out, '--test-root', rootFile, ...extra], NOW);

describe('snapshot-registry', () => {
  it('writes the verified layout byte for byte, fetching only the signed files with the client hygiene', async () => {
    serve();
    const out = outDir('ok');
    const result = await snapshot(out);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain('wrote index.json v10 (keys.json v1, 2 pack file(s)');
    for (const [path, bytes] of layout.files) {
      expect(Buffer.from(readFileSync(join(out, ...path.split('/')))).equals(bytes)).toBe(true);
    }
    expect(served.requests.map((r) => r.path).sort()).toEqual(
      [...layout.files.keys()].map((p) => `/registry/v1/${p}`).sort(),
    );
    for (const request of served.requests) {
      expect(request.agent).toBe('BrowserHive');
      expect(request.cookie).toBeNull();
      expect(request.search).toBe('');
    }
    // A second run replaces its own earlier snapshot.
    expect((await snapshot(out)).code).toBe(0);
  });

  it('refuses a swapped pack file, and writes nothing', async () => {
    const files = new Map(layout.files);
    const path = [...files.keys()].find((p) => p.startsWith('packs/site-b.test/')) ?? '';
    files.set(path, canonical({ ...pack('site-b.test', 5), title: 'Swapped' }));
    serve(files);
    const out = outDir('swapped');
    const result = await snapshot(out);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain('refused, nothing written');
    expect(result.lines[0]).toContain(path);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an index changed after signing, before fetching any pack file', async () => {
    const files = new Map(layout.files);
    files.set('index.json', canonical({ ...layout.indexDoc, version: 11 }));
    serve(files);
    const out = outDir('tampered');
    const result = await snapshot(out);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain('index.json.sig: bad_signature');
    expect(served.requests.some((r) => r.path.includes('/packs/'))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an index signed by a key keys.json does not list', async () => {
    const files = new Map(layout.files);
    const index = files.get('index.json') ?? new Uint8Array();
    files.set('index.json.sig', sigOf(index, testKey()));
    serve(files);
    const result = await snapshot(outDir('foreign'));
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain('index.json.sig: unknown_key');
  });

  it('does not follow a redirect', async () => {
    serve();
    served.redirects.add('keys.json');
    const result = await snapshot(outDir('redirect'));
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain('answered 302 (redirects are not followed)');
    expect(served.requests).toHaveLength(1);
  });

  it('refuses an oversized file while it streams', async () => {
    const files = new Map(layout.files);
    files.set('keys.json.sig', new Uint8Array(5 * 1024).fill(0x20));
    serve(files);
    const result = await snapshot(outDir('big'));
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain('is larger than 4096 bytes');
  });

  it('never replaces a target that is not a layout', async () => {
    serve();
    const out = join(work, 'mine');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'notes.txt'), 'keep');
    const result = await snapshot(out);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain('holds no signed layout; refusing to replace it');
    expect(readFileSync(join(out, 'notes.txt'), 'utf8')).toBe('keep');
    expect(served.requests).toEqual([]);
  });

  it('without --test-root, a plain http:// URL is refused (a release reads https only)', async () => {
    serve();
    if (trustsNothing(PINNED_TRUST_ROOT)) return; // covered by the next case until the ceremony
    const result = await snapshotRegistry(['--url', base, '--out', outDir('http')], NOW);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain('--url must be https://');
    expect(served.requests).toEqual([]);
  });

  it("with this build's own root: fails closed before any request while it pins no keys (CLI entry, exit 1)", async () => {
    serve();
    const out = outDir('pinned');
    const child = Bun.spawn(
      [
        process.execPath,
        join(REPO, 'scripts', 'snapshot-registry.ts'),
        '--url',
        base,
        '--out',
        out,
      ],
      { cwd: REPO, stdout: 'pipe', stderr: 'pipe' },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false);
    if (trustsNothing(PINNED_TRUST_ROOT)) {
      expect(stderr).toContain(CEREMONY_MESSAGE);
      expect(served.requests).toEqual([]);
    } else {
      // After the ceremony the pinned root refuses the test-signed layout (or the http URL).
      expect(stderr).toContain('refused, nothing written');
    }
  }, 60_000);
});

/** The registry client against a `Bun.serve` fake registry over loopback HTTP (spec 13 §10.4, §17 T4b acceptance): the automatic check downloads only the four signed files (the server's request log), with no cookie, query, body, version or install identifier; an ETag that is not the body's hash is never echoed and a hash ETag yields a `304` with no download; redirects are not followed, bodies are capped while streaming, slow servers time out; with the update check off a server that fails on any request sees none. */

import { afterEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { constants, createBrotliCompress } from 'node:zlib';
import { sha256Hex } from '../../src/domain/site-packs/load.ts';
import {
  createRegistryFetcher,
  REGISTRY_USER_AGENT,
  registryUrlProblem,
} from '../../src/infra/site-packs/registry-fetcher.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { createClientKit, signRegistry } from '../helpers/registry-client-kit.ts';
import { sitePack } from '../helpers/site-pack-kit.ts';

const NOW = Date.UTC(2026, 10, 22, 10);

/** `mib` MiB of zeros, Brotli-compressed in chunks (never held whole). */
function brotliBomb(mib: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const z = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } });
    const out: Buffer[] = [];
    z.on('data', (c: Buffer) => out.push(c));
    z.on('end', () => resolve(new Uint8Array(Buffer.concat(out))));
    z.on('error', reject);
    const chunk = Buffer.alloc(1024 * 1024);
    let left = mib;
    const pump = () => {
      while (left > 0) {
        left -= 1;
        if (!z.write(chunk)) {
          z.once('drain', pump);
          return;
        }
      }
      z.end();
    };
    pump();
  });
}
const PACK = 'pack-a.test';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Record<string, string>;
  readonly bodyLength: number;
}

type Mode = 'random-etag' | 'sha-etag';

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A fake registry at `/registry/v1/` serving `files`, logging every request. */
function fakeRegistry(files: Map<string, Uint8Array>, mode: Mode = 'random-etag') {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.arrayBuffer();
      seen.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(request.headers),
        bodyLength: body.byteLength,
      });
      const path = url.pathname.replace(/^\/registry\/v1\//, '');
      const bytes = files.get(path);
      if (bytes === undefined) return new Response('not found', { status: 404 });
      // Cloudflare-like: a 32-hex ETag that is not the body's hash; or the hash form.
      const etag =
        mode === 'sha-etag' ? `"${sha256Hex(bytes)}"` : `"${randomBytes(16).toString('hex')}"`;
      if (mode === 'sha-etag' && request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return new Response(new Uint8Array(bytes), {
        headers: { etag, 'content-type': 'application/json' },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/registry/v1/`, seen };
}

async function clientOver(
  url: string,
  registry: ReturnType<typeof signRegistry>,
  updateCheck = true,
) {
  return createClientKit({
    registry,
    updateCheck,
    clock: new FakeClock(NOW),
    fetcher: createRegistryFetcher({ url, allowLoopbackHttp: true }),
  });
}

describe('request hygiene', () => {
  it('the check fetches only the four signed files, with no cookie, query, body or version', async () => {
    const registry = signRegistry({ now: NOW, versions: [{ pack: sitePack(PACK, 2) }] });
    const server = fakeRegistry(registry.files);
    const kit = await clientOver(server.url, registry);
    expect((await kit.client.check()).outcome).toBe('updated');
    expect(server.seen.map((s) => s.path)).toEqual([
      '/registry/v1/keys.json',
      '/registry/v1/keys.json.sig',
      '/registry/v1/index.json',
      '/registry/v1/index.json.sig',
    ]);
    for (const s of server.seen) {
      expect(s.method).toBe('GET');
      expect(s.search).toBe('');
      expect(s.bodyLength).toBe(0);
      expect(s.headers['cookie']).toBeUndefined();
      expect(s.headers['user-agent']).toBe(REGISTRY_USER_AGENT);
      // Exactly these headers: nothing names the version, the runtime or the install.
      expect(Object.keys(s.headers).sort()).toEqual([
        'accept',
        'accept-encoding',
        'host',
        'user-agent',
      ]);
      expect(Object.values(s.headers).join(' ')).not.toMatch(/0\.3\.0|bun/i);
      expect(s.headers['accept-encoding']).toBe('identity');
      expect(s.headers['if-none-match']).toBeUndefined();
    }
  });

  it('never echoes an ETag that is not the body hash; sends only the held body hash', async () => {
    const registry = signRegistry({ now: NOW, versions: [{ pack: sitePack(PACK, 2) }] });
    const server = fakeRegistry(registry.files);
    const kit = await clientOver(server.url, registry);
    await kit.client.check();
    server.seen.length = 0;
    expect((await kit.client.check()).outcome).toBe('not_modified');
    const sent = server.seen.map((s) => s.headers['if-none-match']);
    expect(sent).toEqual(
      ['keys.json', 'keys.json.sig', 'index.json', 'index.json.sig'].map(
        (f) => `"${sha256Hex(registry.files.get(f) ?? new Uint8Array())}"`,
      ),
    );
  });

  it('a host whose ETag is the body hash answers 304 and nothing is downloaded', async () => {
    const registry = signRegistry({ now: NOW, versions: [{ pack: sitePack(PACK, 2) }] });
    const server = fakeRegistry(registry.files, 'sha-etag');
    const fetcher = createRegistryFetcher({ url: server.url, allowLoopbackHttp: true });
    const held = registry.files.get('index.json') ?? new Uint8Array();
    const result = await fetcher.fetch({
      path: 'index.json',
      maxBytes: 1 << 20,
      heldSha256: sha256Hex(held),
    });
    expect(result.kind).toBe('not_modified');
    const kit = await clientOver(server.url, registry);
    await kit.client.check();
    expect((await kit.client.check()).outcome).toBe('not_modified');
  });

  it('with the update check off, no request reaches the registry', async () => {
    const registry = signRegistry({ now: NOW, versions: [{ pack: sitePack(PACK, 2) }] });
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests += 1;
        throw new Error('the update check is off: no request may arrive');
      },
    });
    servers.push(server);
    const kit = await clientOver(`http://127.0.0.1:${server.port}/registry/v1/`, registry, false);
    expect((await kit.client.check('admin')).outcome).toBe('disabled');
    await expect(kit.client.download(PACK, 2, 'admin')).rejects.toMatchObject({
      code: 'SITE_PACKS_REGISTRY_UNAVAILABLE',
    });
    await expect(kit.client.downloadAll('admin')).rejects.toMatchObject({
      code: 'SITE_PACKS_REGISTRY_UNAVAILABLE',
    });
    expect(kit.timers).toEqual([]);
    expect(requests).toBe(0);
  });
});

describe('the fetcher', () => {
  it('refuses http, credentials and queries in the URL (loopback http only through the seam)', () => {
    expect(registryUrlProblem('https://browserhive.ai/registry/v1/')).toBeNull();
    expect(registryUrlProblem('http://browserhive.ai/registry/v1/')).toContain('https');
    expect(registryUrlProblem('http://127.0.0.1:9/registry/v1/')).toContain('https');
    expect(registryUrlProblem('http://127.0.0.1:9/registry/v1/', true)).toBeNull();
    expect(registryUrlProblem('http://example.test/registry/v1/', true)).toContain('https');
    expect(registryUrlProblem('https://u:p@browserhive.ai/registry/v1/')).toContain('credentials');
    expect(registryUrlProblem('https://browserhive.ai/registry/v1/?id=1')).toContain('query');
  });

  it('does not follow a redirect', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/x?id=1' } }),
    });
    servers.push(server);
    const fetcher = createRegistryFetcher({
      url: `http://127.0.0.1:${server.port}/r/`,
      allowLoopbackHttp: true,
    });
    const result = await fetcher.fetch({ path: 'index.json', maxBytes: 1024 });
    expect(result).toMatchObject({ kind: 'failed', reason: 'redirect', status: 302 });
  });

  it('refuses a compressed body without inflating it (a Brotli bomb, review #100 H1)', async () => {
    // 512 MiB of zeros compress to a few hundred bytes of Brotli.
    const bomb = await brotliBomb(512);
    expect(bomb.byteLength).toBeLessThan(16 * 1024);
    let acceptEncoding = null as string | null;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        acceptEncoding = request.headers.get('accept-encoding');
        return new Response(Buffer.from(bomb), { headers: { 'content-encoding': 'br' } });
      },
    });
    servers.push(server);
    const fetcher = createRegistryFetcher({
      url: `http://127.0.0.1:${server.port}/r/`,
      allowLoopbackHttp: true,
    });
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    const result = await fetcher.fetch({ path: 'index.json', maxBytes: 256 * 1024 });
    const grown = process.memoryUsage().rss - before;
    expect(result).toMatchObject({ kind: 'failed', reason: 'encoding' });
    expect(acceptEncoding).toBe('identity');
    expect(grown).toBeLessThan(64 * 1024 * 1024);
  });

  it('caps the body while it streams', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(new Uint8Array(300 * 1024)),
    });
    servers.push(server);
    const fetcher = createRegistryFetcher({
      url: `http://127.0.0.1:${server.port}/r/`,
      allowLoopbackHttp: true,
    });
    const result = await fetcher.fetch({ path: 'index.json', maxBytes: 256 * 1024 });
    expect(result).toMatchObject({ kind: 'failed', reason: 'too_large' });
  });

  it('times out a server that does not answer', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Promise<Response>(() => undefined),
    });
    servers.push(server);
    const fetcher = createRegistryFetcher({
      url: `http://127.0.0.1:${server.port}/r/`,
      allowLoopbackHttp: true,
      headersTimeoutMs: 100,
    });
    const result = await fetcher.fetch({ path: 'index.json', maxBytes: 1024 });
    expect(result).toMatchObject({ kind: 'failed', reason: 'timeout' });
  });

  it('refuses a path outside the layout', async () => {
    const fetcher = createRegistryFetcher({ url: 'https://browserhive.ai/registry/v1/' });
    const result = await fetcher.fetch({ path: '../secrets.json', maxBytes: 1024 });
    expect(result).toMatchObject({ kind: 'failed', reason: 'insecure_url' });
  });
});

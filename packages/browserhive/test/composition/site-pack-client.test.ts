/** @module test/composition/site-pack-client.test — the registry client in a real server (spec 13 §10.4, §17 T4b acceptance) against a `Bun.serve` fake registry reached through the testing seam: the automatic check runs after its first delay with no template and fetches only the four signed files; with `sitePacksUpdateCheck=false`, or with this build's pinned (empty) root, a registry that fails on any request sees none; the seam accepts only a loopback registry. */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { signRegistry } from '@browserhive/core/test/registry-client-kit';
import { sitePack } from '@browserhive/core/test/site-pack-kit';
import type { BootContext } from '../../src/composition/context.ts';
import { bootServer, type PhaseDefinition } from '../../src/composition/index.ts';
import { testingRegistryProblem } from '../../src/composition/testing-seam.ts';
import { bootInputFor, tempDir } from './support.ts';

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function capturing(seen: { ctx: BootContext | null }) {
  return (defaults: readonly PhaseDefinition[]): readonly PhaseDefinition[] =>
    defaults.map((phase) =>
      phase.name !== 'build-domain'
        ? phase
        : {
            ...phase,
            run: async (ctx) => {
              const handle = await phase.run(ctx);
              seen.ctx = ctx;
              return handle;
            },
          },
    );
}

/** A fake registry serving `files` under `/registry/v1/`; `paths` logs every request. */
function serve(files: ReadonlyMap<string, Uint8Array>, refuseAll = false) {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      paths.push(url.pathname + url.search);
      if (refuseAll) return new Response('no request may arrive', { status: 500 });
      const bytes = files.get(url.pathname.replace(/^\/registry\/v1\//, ''));
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(bytes));
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/registry/v1/`, paths };
}

async function until(test: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await Bun.sleep(20);
}

describe('the registry client in a server', () => {
  const dir = tempDir('bh-sitepack-client-');
  afterAll(() => dir.cleanup());
  const registry = signRegistry({
    now: Date.now(),
    versions: [{ pack: sitePack('pack-z.test', 1) }],
  });

  it('checks the signed index after the first delay, with no template, fetching only four files', async () => {
    const fake = serve(registry.files);
    const seen: { ctx: BootContext | null } = { ctx: null };
    const server = await bootServer(
      {
        ...bootInputFor(`${dir.path}/on`),
        sitePacksTrustRoot: registry.trustRoot,
        sitePacksTesting: { url: fake.url, firstCheckMs: 50 },
      },
      { phases: capturing(seen) },
    );
    try {
      await until(() => fake.paths.length >= 4);
      await until(() => seen.ctx?.domain?.sitePacks.status().index_version === 10);
      expect(fake.paths).toEqual([
        '/registry/v1/keys.json',
        '/registry/v1/keys.json.sig',
        '/registry/v1/index.json',
        '/registry/v1/index.json.sig',
      ]);
      const status = seen.ctx?.domain?.sitePacks.status();
      expect(status).toMatchObject({ index_version: 10, last_outcome: 'updated', check_off: null });
      expect(seen.ctx?.domain?.sitePacks.get('pack-z.test')?.online?.version).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it('with sitePacksUpdateCheck=false no request reaches the registry', async () => {
    const fake = serve(registry.files, true);
    const server = await bootServer({
      ...bootInputFor(`${dir.path}/off`, { sitePacksUpdateCheck: false }),
      sitePacksTrustRoot: registry.trustRoot,
      sitePacksTesting: { url: fake.url, firstCheckMs: 10 },
    });
    try {
      await Bun.sleep(300);
      expect(fake.paths).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it('with the pinned root (no keys before the ceremony) no request reaches the registry', async () => {
    const fake = serve(registry.files, true);
    const seen: { ctx: BootContext | null } = { ctx: null };
    const server = await bootServer(
      { ...bootInputFor(`${dir.path}/pinned`), sitePacksTesting: { url: fake.url, firstCheckMs: 10 } },
      { phases: capturing(seen) },
    );
    try {
      await Bun.sleep(300);
      expect(fake.paths).toEqual([]);
      expect(seen.ctx?.domain?.sitePacks.status().check_off).toBe('no_trust_root');
    } finally {
      await server.stop();
    }
  });

  it('the testing seam accepts only a loopback registry', () => {
    expect(testingRegistryProblem({ sitePacksRegistry: { url: 'http://127.0.0.1:1/r/' } })).toBeNull();
    expect(testingRegistryProblem({ sitePacksRegistry: { url: 'http://example.test/r/' } })).toContain(
      'https',
    );
    expect(testingRegistryProblem(undefined)).toBeNull();
  });
});

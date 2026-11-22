/**
 * @module browserhive/test/e2e/fake-registry — a signed site-pack registry for the end-to-end daemon and the
 * dashboard's real-server screenshots (spec 13 §10, §17 T4b): throwaway root and online keys made at
 * start (never stored), served over loopback HTTP under `/registry/v1/`. It lists the next version of
 * two bundled packs: `github.com` one blocking guard stricter (tightening) and `linkedin.com` with its
 * first guard removed (loosening), so the Site packs page shows both kinds of pending update.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SitePackV1Input } from '@browserhive/contracts/site-packs';
import type { SitePacksTrustRoot } from '@browserhive/core/ports/site-packs';
import { signRegistry } from '@browserhive/core/test/registry-client-kit';

const PACKS = join(import.meta.dir, '../../../../registry/packs');

function bundled(id: string): SitePackV1Input {
  return JSON.parse(readFileSync(join(PACKS, `${id}.json`), 'utf8')) as SitePackV1Input;
}

/** The registry's packs: the next version of two bundled ones. */
export function nextVersions(): SitePackV1Input[] {
  const github = bundled('github.com');
  const linkedin = bundled('linkedin.com');
  return [
    {
      ...github,
      version: github.version + 1,
      guards: [
        ...(github.guards ?? []),
        {
          id: 'repo-delete',
          kind: 'destructive',
          match: { url: 'github.com/*/*/settings/delete', methods: ['DELETE'] },
          action: 'block',
        },
      ],
    },
    { ...linkedin, version: linkedin.version + 1, guards: (linkedin.guards ?? []).slice(1) },
  ];
}

/** A started fake registry. */
export interface FakeRegistry {
  readonly url: string;
  readonly trustRoot: SitePacksTrustRoot;
  /** Every request path seen. */
  readonly requests: string[];
  stop(): void;
}

/** Signs and serves the registry on an ephemeral loopback port. */
export function startFakeRegistry(now = Date.now()): FakeRegistry {
  const registry = signRegistry({
    now,
    versions: nextVersions().map((pack) => ({
      pack,
      notes:
        pack.id === 'github.com'
          ? 'Blocks deleting a repository through the API.'
          : 'Drops the first guard after a site change.',
    })),
  });
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      const bytes = registry.files.get(url.pathname.replace(/^\/registry\/v1\//, ''));
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/json' } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/registry/v1/`,
    trustRoot: registry.trustRoot,
    requests,
    stop: () => server.stop(true),
  };
}

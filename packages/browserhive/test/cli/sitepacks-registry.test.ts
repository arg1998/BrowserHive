/** @module test/cli/sitepacks-registry.test — the registry client's commands (spec 13 §10.4–§10.6, §11.5): `sitepacks check` (routes, outcomes, `check_off` reasons, exit 0/1/2), `sitepacks download <id> [<version>]` (the version it picks, the classified diff, refusals), `download --all` (summary, refusals), and the registry state `list` and `show` print. */
import { describe, expect, it } from 'bun:test';
import type {
  SitePackCheckResponse,
  SitePackDownloadAllResponse,
  SitePackPending,
  SitePackRegistryStatus,
} from '@browserhive/contracts/http';
import {
  catalogBody,
  diffBody,
  fakePackServer,
  packView,
  problem,
  run,
  SHA_B,
  URL_FLAGS,
  writes,
} from './sitepacks-fakes.ts';

const CHECKED_AT = Date.parse('2026-11-22T12:00:00Z');
const KEY_ID = 'k'.repeat(4).replace(/k/g, 'ab12');

function registryStatus(overrides: Partial<SitePackRegistryStatus> = {}): SitePackRegistryStatus {
  return {
    ...catalogBody([]).status,
    update_check: true,
    check_off: null,
    trusts_registry: true,
    url: 'https://browserhive.ai/registry/v1/',
    last_check_at: CHECKED_AT,
    last_ok_at: CHECKED_AT,
    last_outcome: 'updated',
    next_check_at: CHECKED_AT + 86_400_000,
    index_version: 12,
    index_issued_at: CHECKED_AT - 60_000,
    index_expires_at: CHECKED_AT + 7 * 86_400_000,
    index_signed_by: KEY_ID,
    index_packs: 10,
    index_origin: 'registry',
    keys_version: 1,
    ...overrides,
  };
}

/** A registry version listed in the signed index, not downloaded yet. */
function available(version: number): SitePackPending {
  return {
    version,
    sha256: SHA_B,
    state: 'available',
    size: 2048,
    released: '2026-11-20',
    notes: 'Blocks the new sign-out address.',
    classification: 'unclassified',
    source: 'remote',
    provenance: { kind: 'remote', key_id: KEY_ID, index_version: 12 },
  };
}

function checkBody(
  outcome: SitePackCheckResponse['outcome'],
  status = registryStatus(),
  extra: Partial<SitePackCheckResponse> = {},
): SitePackCheckResponse {
  return { outcome, checked_at: CHECKED_AT, available: 1, status, ...extra };
}

describe('sitepacks check', () => {
  it('checks now, then reads the catalog; exit 2 when a followed pack has a pending update', async () => {
    const server = fakePackServer(packView({ pending: [available(5)] }));
    server.routes = (method, path) =>
      method === 'POST' && path === '/api/v1/site-packs/check'
        ? [200, checkBody('updated')]
        : undefined;
    const result = await run(server, ['check', ...URL_FLAGS]);
    expect(result.code).toBe(2);
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/site-packs/check',
      'GET /api/v1/site-packs',
    ]);
    expect(result.stdout).toContain('registry checked');
    expect(result.stdout).toContain('a new index verified (v12)');
    expect(result.stdout).toContain('Registry index: v12 from the registry · 10 pack(s)');
    expect(result.stdout).toContain(
      'Update check: https://browserhive.ai/registry/v1/ every 24 h (signed index only)',
    );
    expect(result.stdout).toContain('1 pending update(s) of followed packs');
    expect(result.stdout).toContain('browserhive sitepacks list --pending');
  });

  it('exit 0 when nothing waits; --json adds the pending counts to the check answer', async () => {
    const server = fakePackServer(packView({ pending: [] }));
    server.routes = (method, path) =>
      method === 'POST' && path === '/api/v1/site-packs/check'
        ? [200, checkBody('not_modified')]
        : undefined;
    const text = await run(server, ['check', ...URL_FLAGS]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('no change since the last check');
    const json = await run(server, ['check', '--json', ...URL_FLAGS]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      outcome: string;
      pending_count: number;
      local_needing_approval: number;
    };
    expect(parsed).toMatchObject({
      outcome: 'not_modified',
      pending_count: 0,
      local_needing_approval: 0,
    });
  });

  it('a failed check exits 1 with its reason; a stale index warns with a clock hint', async () => {
    const server = fakePackServer(packView({ pending: [] }));
    const status = registryStatus({
      stale: true,
      clock_skew_ms: -3 * 3_600_000,
      failures: 3,
      last_outcome: 'failed',
      last_error: { code: 'SITE_PACKS_FETCH_FAILED', message: 'connect ECONNREFUSED' },
    });
    server.routes = (method, path) =>
      method === 'POST' && path === '/api/v1/site-packs/check'
        ? [
            200,
            checkBody('failed', status, {
              error: { code: 'SITE_PACKS_FETCH_FAILED', message: 'connect ECONNREFUSED' },
            }),
          ]
        : undefined;
    const result = await run(server, ['check', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('registry check failed');
    expect(result.stdout).toContain('[SITE_PACKS_FETCH_FAILED] connect ECONNREFUSED');
    expect(result.stdout).toContain('the held registry index expired (stale)');
    expect(result.stdout).toContain("this machine's clock is 3 h behind the registry's");
  });

  it.each([
    ['update_check_off', 'update check off (sitePacksUpdateCheck=false): no request'],
    ['no_trust_root', 'this build pins no registry keys yet: no update check runs'],
    ['packs_off', 'site packs are off (sitePacks=false): no request'],
  ] as const)('outcome disabled (%s) says why no request was made, exit 0', async (off, text) => {
    const server = fakePackServer(packView({ pending: [] }));
    server.routes = (method, path) =>
      method === 'POST' && path === '/api/v1/site-packs/check'
        ? [200, checkBody('disabled', registryStatus({ check_off: off, index_version: null }))]
        : undefined;
    const result = await run(server, ['check', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no check made');
    expect(result.stdout).toContain(text);
    expect(result.stdout).toContain('Registry index: none held yet');
  });

  it('a refusal (rate limit) exits 1 with the server code and reads nothing else', async () => {
    const server = fakePackServer();
    server.routes = () => [429, problem(429, 'RATE_LIMITED', 'Too many checks.')];
    const result = await run(server, ['check', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[RATE_LIMITED]');
    expect(server.calls).toHaveLength(1);
  });
});

function downloadRoutes(server: ReturnType<typeof fakePackServer>, seen: unknown[]) {
  server.routes = (method, path, body) => {
    if (method === 'POST' && path === '/api/v1/site-packs/linkedin.com/download') {
      seen.push(body);
      const version = (body as { version: number }).version;
      const downloaded: SitePackPending = {
        ...available(version),
        state: 'downloaded',
        classification: 'tightening',
      };
      return [
        200,
        {
          view: { ...server.view, pending: [downloaded] },
          diff: { ...diffBody(version, SHA_B), classification: 'tightening' },
        },
      ];
    }
    return undefined;
  };
}

describe('sitepacks download <pack> [<version>]', () => {
  it('without a version downloads the pending available one and prints its classified diff', async () => {
    const server = fakePackServer(packView({ pending: [available(4), available(5)] }));
    const seen: unknown[] = [];
    downloadRoutes(server, seen);
    const result = await run(server, ['download', 'linkedin.com', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(seen).toEqual([{ version: 5 }]);
    expect(writes(server)).toEqual(['POST /api/v1/site-packs/linkedin.com/download']);
    expect(result.stdout).toContain('downloaded linkedin.com v5');
    expect(result.stdout).toContain('released 2026-11-20 · signature and hash verified');
    expect(result.stdout).toContain("Publisher's notes: Blocks the new sign-out address.");
    expect(result.stdout).toContain('Classification: tightens rules (tightening)');
    expect(result.stdout).toContain('guards[logout].action');
    expect(result.stdout).toContain('browserhive sitepacks apply linkedin.com 5');
  });

  it("without a pending one takes the index's newest usable version", async () => {
    const server = fakePackServer(
      packView({
        pending: [],
        online: {
          version: 7,
          sha256: SHA_B,
          size: 1000,
          released: '2026-11-21',
          notes: 'n',
          revoked: false,
          needs_client: '>=0.5.0',
          usable_version: 6,
        },
      }),
    );
    const seen: unknown[] = [];
    downloadRoutes(server, seen);
    const result = await run(server, ['download', 'linkedin.com', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(seen).toEqual([{ version: 6 }]);
  });

  it('an explicit version is sent as is, without reading the pack first', async () => {
    const server = fakePackServer();
    const seen: unknown[] = [];
    downloadRoutes(server, seen);
    const result = await run(server, ['download', 'linkedin.com', '9', '--json', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(seen).toEqual([{ version: 9 }]);
    expect(server.calls).toHaveLength(1);
    const parsed = JSON.parse(result.stdout) as { diff: { classification: string } };
    expect(parsed.diff.classification).toBe('tightening');
  });

  it('exit 1 without sending anything when the index lists nothing usable', async () => {
    const unlisted = fakePackServer(packView({ pending: [], online: null }));
    const none = await run(unlisted, ['download', 'linkedin.com', ...URL_FLAGS]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('is not listed in the registry index this server holds');
    expect(writes(unlisted)).toEqual([]);
    const other = fakePackServer(
      packView({
        pending: [],
        online: {
          version: 7,
          sha256: SHA_B,
          size: 1000,
          released: '2026-11-21',
          notes: 'n',
          revoked: false,
          needs_client: '>=0.9.0',
          usable_version: null,
        },
      }),
    );
    const newer = await run(other, ['download', 'linkedin.com', ...URL_FLAGS]);
    expect(newer.code).toBe(1);
    expect(newer.stderr).toContain('v7 needs BrowserHive >=0.9.0');
  });

  it('a refusal (stale index) exits 1 with the server code', async () => {
    const server = fakePackServer();
    server.routes = (method) =>
      method === 'POST'
        ? [
            409,
            problem(
              409,
              'SITE_PACKS_REGISTRY_UNAVAILABLE',
              'The held index expired; downloads wait for a fresh one.',
            ),
          ]
        : undefined;
    const result = await run(server, ['download', 'linkedin.com', '5', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[SITE_PACKS_REGISTRY_UNAVAILABLE]');
  });
});

describe('sitepacks download --all', () => {
  function allRoutes(
    server: ReturnType<typeof fakePackServer>,
    answer: SitePackDownloadAllResponse,
  ) {
    server.routes = (method, path) =>
      method === 'POST' && path === '/api/v1/site-packs/download-all' ? [200, answer] : undefined;
  }

  it('prints what it downloaded, held and the followed updates now pending (exit 0)', async () => {
    const server = fakePackServer();
    allRoutes(server, {
      downloaded: [
        { pack_id: 'linkedin.com', version: 5, sha256: SHA_B },
        { pack_id: 'github.com', version: 3, sha256: SHA_B },
      ],
      held: 4,
      refused: [],
      pending_count: 1,
    });
    const result = await run(server, ['download', '--all', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(writes(server)).toEqual(['POST /api/v1/site-packs/download-all']);
    expect(result.stdout).toContain('downloaded 2 version(s)');
    expect(result.stdout).toContain('4 already held · 0 refused');
    expect(result.stdout).toContain('github.com v3');
    expect(result.stdout).toContain('1 pending update(s) of followed packs');
  });

  it('a refused file is named with its reason and exits 1', async () => {
    const server = fakePackServer();
    allRoutes(server, {
      downloaded: [],
      held: 0,
      refused: [
        {
          pack_id: 'x.com',
          version: 2,
          reason: 'hash_mismatch',
          detail: 'the file is not the one the index lists',
        },
      ],
      pending_count: 0,
    });
    const result = await run(server, ['download', '--all', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('x.com v2 refused');
    expect(result.stdout).toContain('hash_mismatch: the file is not the one the index lists');
  });

  it('usage errors (64): no pack and no --all; a pack with --all', async () => {
    const server = fakePackServer();
    const bare = await run(server, ['download', ...URL_FLAGS]);
    expect(bare.code).toBe(64);
    expect(bare.stderr).toContain("'sitepacks download' requires a pack argument, or --all");
    const both = await run(server, ['download', 'linkedin.com', '--all', ...URL_FLAGS]);
    expect(both.code).toBe(64);
    expect(both.stderr).toContain("'sitepacks download --all' takes no pack");
    expect(server.calls).toEqual([]);
  });
});

describe('the registry state in list and show', () => {
  it('list marks available and revoked versions, says "registry" and prints the registry lines', async () => {
    const view = packView({
      sources: ['bundled', 'remote'],
      approved_revoked: true,
      approved: {
        version: 3,
        sha256: SHA_B,
        source: 'remote',
        provenance: { kind: 'remote', key_id: KEY_ID, index_version: 11 },
        by: 'admin',
        at: CHECKED_AT,
      },
      pending: [available(5)],
    });
    const server = fakePackServer(view);
    server.routes = (method, path) =>
      method === 'GET' && path === '/api/v1/site-packs'
        ? [200, { ...catalogBody([view]), status: registryStatus() }]
        : undefined;
    const result = await run(server, ['list', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /linkedin\.com\s+v3 \(revoked\)\s+registry\s+—\s+v5 \(available\)/,
    );
    expect(result.stdout).toContain('Registry index: v12 from the registry');
  });

  it('show lists what the index offers and each pending version with its notes', async () => {
    const server = fakePackServer(
      packView({
        approved_revoked: true,
        pending: [available(5)],
        online: {
          version: 6,
          sha256: SHA_B,
          size: 2048,
          released: '2026-11-21',
          notes: 'n',
          revoked: false,
          needs_client: '>=0.9.0',
          usable_version: 5,
        },
      }),
    );
    const result = await run(server, ['show', 'linkedin.com', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'v6 · 2.0 kB · released 2026-11-21 · needs BrowserHive >=0.9.0 · newest usable here: v5',
    );
    expect(result.stdout).toContain('the publisher revoked the approved version');
    expect(result.stdout).toContain(
      'v5: available (not downloaded) · registry (key ab12ab12ab12ab12, index 12, signature verified)',
    );
    expect(result.stdout).toContain('— Blocks the new sign-out address.');
  });
});

/** @module test/cli/sitepacks.test — `browserhive sitepacks list | show | diff` and the usage errors of every subcommand (spec 13 §11.5): routes called, text and `--json` output, exit codes 0, 1, 2 and 64 */
import { describe, expect, it } from 'bun:test';
import {
  fakePackServer,
  PACK_BODY,
  packView,
  problem,
  run,
  SHA_A,
  SHA_L,
  URL_FLAGS,
} from './sitepacks-fakes.ts';

describe('sitepacks list', () => {
  it('prints one row per pack with its approval, pending versions and follow setting', async () => {
    const server = fakePackServer();
    const result = await run(server, ['list', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/PACK\s+APPROVED\s+SOURCE\s+LOCAL FILE\s+PENDING\s+FOLLOW/);
    expect(result.stdout).toMatch(/linkedin\.com\s+v3\s+bundled\s+—\s+v4\s+auto \(on\)\s+1\s+yes/);
    expect(result.stdout).toContain('Local folder: /data/site-packs/local');
    expect(result.stdout).toContain('1 pending update(s), 0 local file(s) waiting for approval');
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/site-packs']);
  });

  it('is the default subcommand', async () => {
    const result = await run(fakePackServer(), URL_FLAGS);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('linkedin.com');
  });

  it('--pending exits 2 when an update waits, and passes the filters', async () => {
    const server = fakePackServer();
    const result = await run(server, [
      'list',
      '--pending',
      '--source',
      'local,bundled',
      ...URL_FLAGS,
    ]);
    expect(result.code).toBe(2);
    expect(server.calls[0]?.path).toBe('/api/v1/site-packs?source=local%2Cbundled&pending=true');
  });

  it('--pending exits 2 for a local file waiting for approval, 0 when nothing waits', async () => {
    const local = packView({
      pending: [],
      local: {
        path: '/x/linkedin.com.json',
        sha256: SHA_L,
        state: 'changed',
        approved_sha256: SHA_A,
        problem: null,
      },
    });
    const waiting = await run(fakePackServer(local), ['list', '--pending', ...URL_FLAGS]);
    expect(waiting.code).toBe(2);
    expect(waiting.stdout).toContain('changed since approval — review');
    const idle = await run(fakePackServer(packView({ pending: [] })), [
      'list',
      '--pending',
      ...URL_FLAGS,
    ]);
    expect(idle.code).toBe(0);
  });

  it('without --pending exits 0 even with pending updates; --json prints the response', async () => {
    const result = await run(fakePackServer(), ['list', '--json', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { pending_count: number; data: unknown[] };
    expect(parsed.pending_count).toBe(1);
    expect(parsed.data).toHaveLength(1);
  });

  it('shows a pinned pack and an unapproved offer', async () => {
    const pinned = packView({ pinned_version: 3 });
    const pinnedResult = await run(fakePackServer(pinned), ['list', ...URL_FLAGS]);
    expect(pinnedResult.stdout).toContain('pinned at v3, v4 available');
    const offered = packView({
      approved: null,
      pending: [],
      offer: {
        version: 3,
        sha256: SHA_A,
        source: 'bundled',
        provenance: { kind: 'bundled', release: '0.3.0' },
      },
    });
    const offeredResult = await run(fakePackServer(offered), ['list', ...URL_FLAGS]);
    expect(offeredResult.stdout).toContain('not approved (v3 offered)');
  });
});

describe('sitepacks show', () => {
  it('prints the approval with its provenance and SHA-256, pending versions and the rules', async () => {
    const server = fakePackServer();
    server.routes = (method, path) =>
      method === 'GET' && path === '/api/v1/site-packs/linkedin.com'
        ? [
            200,
            {
              view: server.view,
              pack: PACK_BODY,
              versions: [{ version: 3, sha256: SHA_A, source: 'bundled', state: 'approved' }],
            },
          ]
        : undefined;
    const result = await run(server, ['show', 'LinkedIn.com', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('LinkedIn (linkedin.com)');
    expect(result.stdout).toContain('v3 · bundled with BrowserHive 0.3.0 by admin');
    expect(result.stdout).toContain(SHA_A);
    expect(result.stdout).toContain('confirm by default · terms: prohibited');
    expect(result.stdout).toContain('Rules: 1 guard(s) · 0 element guard(s) · 0 challenge(s)');
    expect(result.stdout).toContain('"You agree not to use bots."');
    expect(result.stdout).toContain('Verified: guards 2026-11-01');
  });

  it('an unknown pack fails with exit 1 and the server code', async () => {
    const server = fakePackServer();
    server.routes = () => [404, problem(404, 'SITE_PACK_NOT_FOUND', 'No site pack example.com.')];
    const result = await run(server, ['show', 'example.com', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[SITE_PACK_NOT_FOUND] No site pack example.com.');
  });
});

describe('sitepacks diff', () => {
  it('without --to diffs the only pending version', async () => {
    const server = fakePackServer();
    const result = await run(server, ['diff', 'linkedin.com', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('linkedin.com: v3 (bundled, sha-256 aaaaaaaaaaaa…) → v4');
    expect(result.stdout).toContain('guards[logout].action');
    expect(result.stdout).toContain('- "confirm"');
    expect(result.stdout).toContain('+ "block"');
    expect(server.calls.at(-1)?.path).toBe('/api/v1/site-packs/linkedin.com/diff?to=4');
  });

  it('--to local diffs the local file; --json prints the diff', async () => {
    const server = fakePackServer();
    const result = await run(server, [
      'diff',
      'linkedin.com',
      '--to',
      'local',
      '--json',
      ...URL_FLAGS,
    ]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as { to: { sha256: string } }).to.sha256).toBe(SHA_L);
    expect(server.calls.map((c) => c.path)).toEqual([
      '/api/v1/site-packs/linkedin.com/diff?to=local',
    ]);
  });

  it('fails when there are several candidates or none', async () => {
    const several = packView({
      local: {
        path: '/x/linkedin.com.json',
        sha256: SHA_L,
        state: 'not_approved',
        approved_sha256: null,
        problem: null,
      },
    });
    const many = await run(fakePackServer(several), ['diff', 'linkedin.com', ...URL_FLAGS]);
    expect(many.code).toBe(1);
    expect(many.stderr).toContain('several candidates (v4, local); pass --to <version|local>');
    const none = await run(fakePackServer(packView({ pending: [] })), [
      'diff',
      'linkedin.com',
      ...URL_FLAGS,
    ]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no pending version and no local file waiting for approval');
  });
});

describe('sitepacks usage errors (64)', () => {
  it.each([
    [['show', 'not a domain'], "invalid pack id 'not a domain'"],
    [['show'], "'sitepacks show' requires a pack argument."],
    [['follow', 'linkedin.com', 'maybe'], "unknown setting 'maybe' for 'sitepacks follow'"],
    [['diff', 'linkedin.com', '--to', 'latest'], "invalid value for --to: 'latest'"],
    [['pin', 'linkedin.com'], "'sitepacks pin' requires a version argument."],
    [['apply', 'linkedin.com', 'v4'], "invalid version 'v4'"],
    [['list', '--source', 'web'], "invalid value for --source: 'web'"],
    [['list', '--token', 'x'], '--token requires --url.'],
  ])('%p', async (argv, message) => {
    const result = await run(fakePackServer(), argv);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(message);
  });
});

/** @module test/cli/saved-logins.test — `browserhive saved-logins list | rm` over the REST API (spec 08 §7.1, spec 03 §4.6.1): the table, `--json`, the owner lookup and the delete call. */

import { describe, expect, it } from 'bun:test';
import type { AuthStateRow } from '@browserhive/contracts/http';
import type { CliDeps } from '../../src/cli/deps.ts';
import { cliHarness } from './helpers.ts';

const ROWS: AuthStateRow[] = [
  {
    name: 'work',
    kind: 'storage',
    owner: 'alice',
    size: 2_048,
    saved_at: 1_758_000_000_000,
    source_session_id: 'shop-0000000a',
    source_session_slug: 'shop',
  },
  {
    name: 'work',
    kind: 'profile',
    owner: 'local',
    size: 5_242_880,
    saved_at: 1_757_000_000_000,
    source_session_id: 'gone-0000000c',
    source_session_slug: null,
  },
  {
    name: 'mail',
    kind: 'profile',
    owner: 'bob',
    size: 1_024,
    saved_at: 1_756_000_000_000,
    source_session_id: 'mail-0000000d',
    source_session_slug: 'mail',
  },
];

/** A fake server: `GET /auth-states` answers ROWS, `DELETE` removes one; every call is recorded. */
function server() {
  const calls: string[] = [];
  const rows = [...ROWS];
  const http: CliDeps['http'] = async (url, init) => {
    const path = url.replace('http://127.0.0.1:9876/api/v1', '');
    calls.push(`${init.method} ${path} ${init.headers['authorization'] ?? ''}`.trim());
    const answer = (status: number, body: unknown) => ({
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (init.method === 'GET' && path === '/auth-states')
      return answer(200, { data: rows, now: 1 });
    const match = /^\/auth-states\/([^/]+)\/([^/]+)$/.exec(path);
    if (init.method === 'DELETE' && match !== null) {
      const owner = decodeURIComponent(match[1] ?? '');
      const name = decodeURIComponent(match[2] ?? '');
      const at = rows.findIndex((r) => r.owner === owner && r.name === name);
      if (at < 0) {
        return answer(404, {
          type: 'about:blank',
          title: 'Saved auth state not found',
          status: 404,
          code: 'AUTH_STATE_NOT_FOUND',
          retryable: 'different_args',
          detail: `No saved auth snapshot named '${name}'. Use list_saved_auths to see what is available.`,
        });
      }
      const [deleted] = rows.splice(at, 1);
      return answer(200, { ok: true, deleted });
    }
    return answer(404, {});
  };
  return { http, calls };
}

const REMOTE = ['--url', 'http://127.0.0.1:9876', '--token', 'bh_operator_x'];

describe('saved-logins list', () => {
  it("prints every principal's saved logins and marks a source session that is gone", async () => {
    const { http, calls } = server();
    const result = await cliHarness({ argv: ['saved-logins', 'list', ...REMOTE], http });
    expect(result.code).toBe(0);
    for (const text of ['NAME', 'OWNER', 'cookies & storage', 'full profile', 'alice', 'local']) {
      expect(result.stdout).toContain(text);
    }
    expect(result.stdout).toContain('5.2 MB');
    expect(result.stdout).toContain('gone-0000000c (deleted)');
    expect(calls).toEqual(['GET /auth-states Bearer bh_operator_x']);
    const json = await cliHarness({ argv: ['saved-logins', '--json', ...REMOTE], http });
    expect((JSON.parse(json.stdout) as AuthStateRow[]).map((r) => r.owner)).toEqual([
      'alice',
      'local',
      'bob',
    ]);
  });
});

describe('saved-logins rm', () => {
  it('deletes the one principal’s login of that name without --owner', async () => {
    const { http, calls } = server();
    const result = await cliHarness({ argv: ['saved-logins', 'rm', 'mail', ...REMOTE], http });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('deleted saved login mail of bob');
    expect(calls.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'GET /auth-states',
      'DELETE /auth-states/bob/mail',
    ]);
  });

  it('asks for --owner when several principals use the name, and deletes nothing', async () => {
    const { http, calls } = server();
    const result = await cliHarness({ argv: ['saved-logins', 'rm', 'work', ...REMOTE], http });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "2 principals have a saved login named 'work' (alice, local). Pass --owner <subject>.",
    );
    expect(calls).toEqual(['GET /auth-states Bearer bh_operator_x']);
  });

  it('deletes the named owner’s login with --owner, encoding the path', async () => {
    const { http, calls } = server();
    const result = await cliHarness({
      argv: ['saved-logins', 'rm', 'work', '--owner', 'local', '--json', ...REMOTE],
      http,
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ owner: 'local', name: 'work' });
    expect(calls).toEqual(['DELETE /auth-states/local/work Bearer bh_operator_x']);
  });

  it('reports a missing login with the server’s problem and exits 1', async () => {
    const { http } = server();
    const unknown = await cliHarness({ argv: ['saved-logins', 'rm', 'nope', ...REMOTE], http });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no saved login named 'nope'");
    const foreign = await cliHarness({
      argv: ['saved-logins', 'rm', 'mail', '--owner', 'alice', ...REMOTE],
      http,
    });
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain('[AUTH_STATE_NOT_FOUND]');
  });

  it('requires a name (usage error, nothing sent)', async () => {
    const { http, calls } = server();
    const result = await cliHarness({ argv: ['saved-logins', 'rm', ...REMOTE], http });
    expect(result.code).toBe(64);
    expect(calls).toEqual([]);
  });
});

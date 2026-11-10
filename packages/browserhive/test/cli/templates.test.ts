/** @module test/cli/templates.test — `browserhive templates list | rm` over the REST API (spec 13 §11.5): the table, `--json`, the typed-name confirmation, `--yes`, `--force` and the refusal without a terminal. */

import { describe, expect, it } from 'bun:test';
import type { TemplateSummary } from '@browserhive/contracts/http';
import type { CliDeps } from '../../src/cli/deps.ts';
import { cliHarness } from './helpers.ts';

const SUMMARY: TemplateSummary = {
  template_id: 'tp-abcdefghij',
  name: 'job-hunt',
  display_name: 'Job hunt',
  status: 'ready',
  channel: 'chromium',
  headless: false,
  sites: [
    { site_id: 'linkedin.com', title: 'linkedin.com', health_state: 'signed_in', checked_at: 1 },
    { site_id: 'indeed.com', title: 'indeed.com', health_state: 'signed_out', checked_at: 1 },
  ],
  host: { state: 'stopped', since: null, pages: 0 },
  in_use: 1,
  cap: 5,
  current_version: null,
  checkpoint_at: null,
  last_used_at: null,
  sealed: true,
};

const URL_FLAGS = ['--url', 'http://127.0.0.1:9876', '--token', 'bh_operator_x'];

/** A fake server: the list, and a delete that records its URL. */
function server(calls: string[]): CliDeps['http'] {
  return async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const body =
      init?.method === 'DELETE'
        ? { ok: true, closed_sessions: ['jobs-11111111'], deleted_bytes: 10 }
        : {
            data: [SUMMARY],
            page: { next_cursor: null, limit: 500 },
            facets: { status: [], host_state: [], health: [] },
            applied: { filters: {}, sort: { key: 'name', dir: 'asc' } },
            meta: { now: 2 },
          };
    return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

describe('templates list', () => {
  it('prints one row per template with its sites and sessions', async () => {
    const calls: string[] = [];
    const result = await cliHarness({
      argv: ['templates', 'list', ...URL_FLAGS],
      http: server(calls),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('job-hunt');
    expect(result.stdout).toContain('linkedin.com ✓, indeed.com ✗');
    expect(result.stdout).toContain('1/5');
    expect(calls).toEqual([
      'GET http://127.0.0.1:9876/api/v1/templates?sort=name&dir=asc&limit=500',
    ]);
    const json = await cliHarness({
      argv: ['templates', '--json', ...URL_FLAGS],
      http: server([]),
    });
    expect((JSON.parse(json.stdout) as TemplateSummary[])[0]?.template_id).toBe('tp-abcdefghij');
  });
});

describe('templates rm', () => {
  it('asks for the name, then deletes by id', async () => {
    const calls: string[] = [];
    const result = await cliHarness({
      argv: ['templates', 'rm', 'job-hunt', '--force', ...URL_FLAGS],
      http: server(calls),
      answers: ['job-hunt'],
    });
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual(["Type the template's name to confirm: "]);
    expect(result.stdout).toContain('It does not sign out at the sites.');
    expect(result.stdout).toContain('1 session(s) closed');
    expect(calls.at(-1)).toBe(
      'DELETE http://127.0.0.1:9876/api/v1/templates/tp-abcdefghij?force=true',
    );
  });

  it('a wrong answer deletes nothing', async () => {
    const calls: string[] = [];
    const result = await cliHarness({
      argv: ['templates', 'rm', 'job-hunt', ...URL_FLAGS],
      http: server(calls),
      answers: ['nope'],
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Aborted — nothing was deleted.');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('refuses without a terminal unless --yes', async () => {
    const calls: string[] = [];
    const refused = await cliHarness({
      argv: ['templates', 'rm', 'job-hunt', ...URL_FLAGS],
      http: server(calls),
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('refusing to delete without confirmation');
    const yes = await cliHarness({
      argv: ['templates', 'rm', 'job-hunt', '--yes', '--json', ...URL_FLAGS],
      http: server(calls),
    });
    expect(yes.code).toBe(0);
    expect(JSON.parse(yes.stdout)).toMatchObject({ ok: true, deleted_bytes: 10 });
    expect(calls.at(-1)).toBe('DELETE http://127.0.0.1:9876/api/v1/templates/tp-abcdefghij');
  });

  it('an unknown name fails without deleting', async () => {
    const calls: string[] = [];
    const result = await cliHarness({
      argv: ['templates', 'rm', 'nope', '--yes', ...URL_FLAGS],
      http: server(calls),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no session template named 'nope'");
  });

  it('needs the name argument', async () => {
    const result = await cliHarness({ argv: ['templates', 'rm', ...URL_FLAGS], http: server([]) });
    expect(result.code).toBe(64);
  });
});

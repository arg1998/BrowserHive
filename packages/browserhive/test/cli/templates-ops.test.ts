/** @module test/cli/templates-ops.test — `browserhive templates show | versions | save | host | disable | enable` over the REST API (spec 13 §11.5): the routes called, text and `--json` output, exit codes and usage errors. */

import { describe, expect, it } from 'bun:test';
import type { TemplateVersionRow } from '@browserhive/contracts/http';
import {
  BASE,
  fakeServer,
  ID,
  paths,
  problem,
  run,
  template,
  URL_FLAGS,
} from './template-fakes.ts';

function versionRow(overrides: Partial<TemplateVersionRow> = {}): TemplateVersionRow {
  return {
    version: 2,
    reason: 'manual',
    restored_from: null,
    size_bytes: 2048,
    summary: { domains: [], storage_origins: 0 },
    health: [
      { site_id: 'linkedin.com', state: 'signed_in', enabled: true },
      { site_id: 'indeed.com', state: 'signed_out', enabled: true },
    ],
    pinned: true,
    last_good: false,
    readable: true,
    created_by: 'admin',
    created_at: 1_758_000_000_000,
    ...overrides,
  };
}

function versionsPage(rows: readonly TemplateVersionRow[], checkpoint: unknown): unknown {
  return {
    data: rows,
    page: { next_cursor: null, limit: 500 },
    applied: { filters: {}, sort: { key: 'version', dir: 'desc' } },
    meta: { now: 2 },
    checkpoint,
  };
}

describe('templates show', () => {
  it('prints the template, its browser and its sites; --json prints the detail', async () => {
    const server = fakeServer({ 'linkedin.com': 'signed_in', 'indeed.com': 'signed_out' });
    server.status = 'ready';
    const result = await run(server, ['show', 'job-hunt', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`job-hunt (${ID}) · ready`);
    expect(result.stdout).toContain('chromium · headed · stealth standard');
    expect(result.stdout).toContain('every agent principal');
    expect(result.stdout).toContain('Browser');
    expect(result.stdout).toContain('1 agent · 0 parked');
    expect(result.stdout).toMatch(/linkedin\.com\s+✓ signed in/);
    expect(result.stdout).toMatch(/indeed\.com\s+✗ signed out/);
    expect(paths(server)).toEqual([`GET ${BASE}?sort=name&dir=asc&limit=500`, `GET ${BASE}/${ID}`]);
    const json = await run(server, ['show', 'job-hunt', '--json', ...URL_FLAGS]);
    const parsed = JSON.parse(json.stdout) as { host: { state: string }; sessions_live: number };
    expect(parsed.host.state).toBe('running');
    expect(parsed.sessions_live).toBe(0);
  });

  it('an unknown name fails with exit 1', async () => {
    const result = await run(fakeServer({ 'a.com': 'signed_in' }), ['show', 'nope', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no session template named 'nope'");
  });
});

describe('templates versions', () => {
  it('prints the table and the checkpoint line, marking unreadable versions', async () => {
    const server = fakeServer({ 'linkedin.com': 'signed_in' });
    server.routes = (method, path) =>
      method === 'GET' && path === `${BASE}/${ID}/versions?limit=500`
        ? [
            200,
            versionsPage(
              [
                versionRow({ version: 3, reason: 'restore', restored_from: 0, pinned: false }),
                versionRow({ version: 1, reason: 'recording', last_good: true, readable: false }),
              ],
              { at: 1_758_000_060_000, size_bytes: 4096, readable: true },
            ),
          ]
        : undefined;
    const result = await run(server, ['versions', 'job-hunt', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /VERSION\s+REASON\s+CREATED\s+SIZE\s+SIGNED IN\s+PINNED\s+LAST GOOD\s+READABLE/,
    );
    expect(result.stdout).toMatch(/v3\s+restore \(from latest\)/);
    expect(result.stdout).toMatch(/v1\s+recording\s+.*1\/2\s+yes\s+yes\s+no/);
    expect(result.stdout).toContain('Checkpoint: 2025-09-16 05:21Z · 4.1 kB');
    expect(result.stdout).toContain(
      'Unreadable: the file is missing or was written with another key',
    );

    const json = await run(server, ['versions', 'job-hunt', '--json', ...URL_FLAGS]);
    const parsed = JSON.parse(json.stdout) as { versions: unknown[]; checkpoint: unknown };
    expect(parsed.versions).toHaveLength(2);
    expect(parsed.checkpoint).toEqual({ at: 1_758_000_060_000, size_bytes: 4096, readable: true });
  });

  it('says so when there is no version and no checkpoint', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    server.routes = (method, path) =>
      method === 'GET' && path.startsWith(`${BASE}/${ID}/versions`)
        ? [200, versionsPage([], null)]
        : undefined;
    const result = await run(server, ['versions', 'job-hunt', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No versions of job-hunt yet.');
    expect(result.stdout).toContain('Checkpoint: none yet');
  });
});

describe('templates save', () => {
  it('reports the new version, or that nothing changed', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    let answer: number | null = 4;
    server.routes = (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/versions`
        ? [200, { version: answer }]
        : undefined;
    const saved = await run(server, ['save', 'job-hunt', ...URL_FLAGS]);
    expect(saved.code).toBe(0);
    expect(saved.stdout).toContain('saved job-hunt as version 4');
    answer = null;
    const same = await run(server, ['save', 'job-hunt', ...URL_FLAGS]);
    expect(same.code).toBe(0);
    expect(same.stdout).toContain('nothing changed in job-hunt');
    const json = await run(server, ['save', 'job-hunt', '--json', ...URL_FLAGS]);
    expect(JSON.parse(json.stdout)).toEqual({ version: null });
  });

  it('a stopped browser (409) is exit 1 with the server message', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    server.routes = (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/versions`
        ? [409, problem(409, 'CONFLICT', "the template's browser is not running")]
        : undefined;
    const result = await run(server, ['save', 'job-hunt', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[CONFLICT] the template's browser is not running");
  });
});

describe('templates host', () => {
  it('posts start, stop or restart and prints the new state', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    server.routes = (method, path) =>
      method === 'POST' && path.startsWith(`${BASE}/${ID}/host/`)
        ? [
            200,
            {
              host: {
                state: path.endsWith('/stop') ? 'stopped' : 'running',
                since: 1,
                started_at: 1,
                restarts: 0,
                pages: 0,
                parked_pages: 0,
                sandboxed: true,
                profile_secrets: false,
              },
            },
          ]
        : undefined;
    const stop = await run(server, ['host', 'job-hunt', 'stop', ...URL_FLAGS]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain('stopped the browser of job-hunt');
    expect(stop.stdout).toContain('now stopped');
    const restart = await run(server, ['host', 'job-hunt', 'restart', '--json', ...URL_FLAGS]);
    expect((JSON.parse(restart.stdout) as { host: { state: string } }).host.state).toBe('running');
    expect(paths(server)).toContain(`POST ${BASE}/${ID}/host/stop`);
    expect(paths(server)).toContain(`POST ${BASE}/${ID}/host/restart`);
  });

  it('an unknown or missing action is a usage error (64) before any request', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    const bad = await run(server, ['host', 'job-hunt', 'reboot', ...URL_FLAGS]);
    expect(bad.code).toBe(64);
    expect(bad.stderr).toContain("unknown action 'reboot' for 'templates host'");
    const missing = await run(server, ['host', 'job-hunt', ...URL_FLAGS]);
    expect(missing.code).toBe(64);
    expect(server.calls).toEqual([]);
  });
});

describe('templates disable | enable', () => {
  it('posts the change and names the sessions it closed', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    server.routes = (method, path) => {
      if (method !== 'POST') return undefined;
      if (path === `${BASE}/${ID}/disable`) {
        return [
          200,
          {
            template: { ...template(server), status: 'disabled' },
            closed_sessions: ['s-1', 's-2'],
          },
        ];
      }
      if (path === `${BASE}/${ID}/enable`) {
        return [200, { template: template(server), closed_sessions: [] }];
      }
      return undefined;
    };
    const off = await run(server, ['disable', 'job-hunt', ...URL_FLAGS]);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('disabled template job-hunt');
    expect(off.stdout).toContain('2 session(s) closed');
    const on = await run(server, ['enable', 'job-hunt', '--json', ...URL_FLAGS]);
    expect(on.code).toBe(0);
    expect((JSON.parse(on.stdout) as { closed_sessions: string[] }).closed_sessions).toEqual([]);
  });
});

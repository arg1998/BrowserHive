/** @module test/cli/templates-health.test — `browserhive templates login | probe` over the REST API (spec 13 §8, §11.5): the re-login body from the flags, the progress text, Enter as **I'm signed in** (a 409 keeps waiting), the endings and their exit codes, cancelling at `--timeout` and on Ctrl+C, unlisted sign-ins, the remote-machine warning, probe lines and hints, `--json` and usage errors. */

import { describe, expect, it } from 'bun:test';
import type { TemplateReloginState } from '@browserhive/contracts/enums';
import type { ProbeResult, ReloginView } from '@browserhive/contracts/http';
import {
  BASE,
  type FakeServer,
  fakeServer,
  ID,
  operator,
  paths,
  problem,
  run,
  URL_FLAGS,
} from './template-fakes.ts';

const LIST = `GET ${BASE}?sort=name&dir=asc&limit=500`;
const DETAIL = `GET ${BASE}/${ID}`;
const RELOGIN = `${BASE}/${ID}/relogin`;
const DEADLINE = Date.UTC(2026, 10, 16, 14, 32);

function view(overrides: Partial<ReloginView> = {}): ReloginView {
  return {
    site_id: 'a.test',
    method: 'window',
    state: 'open',
    session_id: 'maint-2',
    requested_by: 'admin',
    requested_at: 1,
    deadline_at: DEADLINE,
    finished_at: null,
    agents_paused: true,
    sign_in_via: 'window',
    confirm_required: false,
    version: null,
    unlisted_domains: [],
    error: null,
    ...overrides,
  };
}

/** Re-login routes over the fake: start, confirm (409 for sites in `refuse`), cancel. */
function withRelogin(server: FakeServer, started: Partial<ReloginView> = {}): void {
  server.routes = (method, path, body) => {
    if (method === 'POST' && path === RELOGIN) {
      const request = body as { site_id: string; method: ReloginView['method'] };
      server.relogin = view({ site_id: request.site_id, method: request.method, ...started });
      return [200, { session_id: server.relogin.session_id, relogin: server.relogin }];
    }
    if (method === 'POST' && path === `${RELOGIN}/confirm`) {
      const { site_id: site, requested_at } = body as { site_id: string; requested_at?: number };
      // The CLI names the re-login it started (review #81 L-2).
      if (requested_at !== server.relogin?.requested_at) {
        return [409, problem(409, 'CONFLICT', 'another re-login replaced this one')];
      }
      if (server.refuse.has(site)) {
        return [409, problem(409, 'CONFLICT', 'no sign-in cookie came back on this site')];
      }
      server.relogin = finished(server, 'signed_in', { version: 7 });
      return [200, { session_id: null, relogin: server.relogin }];
    }
    if (method === 'DELETE' && path === `${RELOGIN}?requested_at=${server.relogin?.requested_at}`) {
      server.relogin = finished(server, 'cancelled');
      return [200, { session_id: null, relogin: server.relogin }];
    }
    return undefined;
  };
}

function finished(
  server: FakeServer,
  state: TemplateReloginState,
  overrides: Partial<ReloginView> = {},
): ReloginView {
  return view({
    ...server.relogin,
    state,
    session_id: null,
    deadline_at: null,
    finished_at: 2,
    agents_paused: false,
    ...overrides,
  });
}

const LOGIN = ['login', 'job-hunt', '--site', 'a.test'];

describe('templates login: usage', () => {
  it.each([
    [[], "'templates login' requires --site <site>"],
    [['--site', 'a test'], "invalid site 'a test' in --site"],
    [['--site', 'a.test', '--method', 'sms'], 'invalid value for --method'],
    [['--site', 'a.test', '--timeout', 'soon'], 'invalid value for --timeout'],
  ])('rejects %j as a usage error (64)', async (flags, message) => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    const result = await run(server, ['login', 'job-hunt', ...flags, ...URL_FLAGS]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(message);
    expect(server.calls).toEqual([]);
  });

  it('refuses a site the template does not have before starting anything (1)', async () => {
    const server = fakeServer({ 'a.test': 'signed_out', 'b.test': 'signed_in' });
    withRelogin(server);
    const result = await run(server, ['login', 'job-hunt', '--site', 'C.test', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "template 'job-hunt' has no site 'c.test'. Its sites: a.test, b.test.",
    );
    expect(paths(server)).toEqual([LIST]);
  });
});

describe('templates login: window', () => {
  it('starts the re-login, says where and that agents are paused; Enter confirms, a 409 keeps waiting (0)', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server);
    server.refuse.add('a.test');
    const op = operator();
    server.onPoll = (poll) => {
      // Polls 0 (the detail before the start) and 1; Enter at the second wait, accepted the second time.
      if (poll === 1) op.enter();
      if (poll === 2) {
        server.refuse.delete('a.test');
        op.enter();
      }
    };
    server.unlisted = [];
    const result = await run(server, [...LOGIN, ...URL_FLAGS], { op });
    expect(result.code).toBe(0);
    expect(server.calls.find((c) => c.path === RELOGIN)?.body).toEqual({
      site_id: 'a.test',
      method: 'window',
      let_agents_continue: false,
    });
    expect(paths(server)).toEqual([
      LIST,
      DETAIL,
      `POST ${RELOGIN}`,
      DETAIL,
      `POST ${RELOGIN}/confirm`,
      DETAIL,
      `POST ${RELOGIN}/confirm`,
    ]);
    expect(result.stdout).toContain('A window opened on hive-box at a.test.');
    expect(result.stdout).toContain('Type your password rather than pasting it');
    expect(result.stdout).toContain('Agents of job-hunt are paused until you finish');
    expect(result.stdout).toContain('Press Enter here when you are signed in.');
    expect(result.stdout).toContain('The window closes at 2026-11-16 14:32Z.');
    expect(result.stderr).toContain(
      'a.test: not signed in yet (no sign-in cookie came back on this site). Finish signing in in the window, then press Enter again.',
    );
    expect(result.stdout).toContain('a.test is signed in again');
    expect(result.stdout).toContain('saved as version 7');
    expect(result.stderr).not.toContain('This opens a window');
    expect(new Set(op.slept)).toEqual(new Set([2000]));
  });

  it('finishes by itself when the server sees the sign-in, and lists unlisted sign-ins with how to remove them', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server);
    server.onPoll = (poll) => {
      if (poll === 2) {
        server.relogin = finished(server, 'signed_in', {
          version: 4,
          unlisted_domains: ['google.com'],
        });
      }
    };
    const result = await run(server, [...LOGIN, ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(paths(server).filter((p) => p.endsWith('/confirm'))).toEqual([]);
    expect(result.stdout).toContain('Also signed in to: google.com — agents can use this.');
    expect(result.stdout).toContain(
      `POST http://127.0.0.1:9876/api/v1/templates/${ID}/domains/google.com/remove-sign-in`,
    );
  });

  it('a live-view re-login points at the live view; a site already signed in asks for Done (review #81 M-2, M-5)', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server, { state: 'signed_in', sign_in_via: 'live_view', confirm_required: true });
    const result = await run(server, [...LOGIN, ...URL_FLAGS]);
    expect(result.stdout).toContain('sign in to a.test through the live view');
    expect(result.stdout).toContain('/sessions/maint-2?live=1&takeover=1');
    expect(result.stdout).toContain("can't tell when you are done");
  });

  it('warns when the window opens on another machine, never for a loopback URL', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server, { state: 'signed_in', agents_paused: false });
    const far = await run(server, [...LOGIN, '--url', 'http://bh.example:9876']);
    expect(far.code).toBe(0);
    expect(far.stderr).toContain('! This opens a window on hive-box, not on this device.');
  });

  it('--letAgentsContinue asks the server not to pause agents and says they keep running', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server, { agents_paused: false });
    server.onPoll = (poll) => {
      if (poll === 1) server.relogin = finished(server, 'signed_in');
    };
    const result = await run(server, [...LOGIN, '--letAgentsContinue', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(server.calls.find((c) => c.path === RELOGIN)?.body).toMatchObject({
      let_agents_continue: true,
    });
    expect(result.stdout).toContain('Agents of job-hunt keep running while you sign in.');
  });

  it('says when agents are let continue from the dashboard', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server);
    server.onPoll = (poll) => {
      if (poll === 1) server.relogin = view({ agents_paused: false });
      if (poll === 2) server.relogin = finished(server, 'signed_in');
    };
    const result = await run(server, [...LOGIN, ...URL_FLAGS]);
    expect(result.stdout).toContain('· agents of job-hunt continue');
  });

  it.each([
    ['timed_out', 'a.test was not signed in before the window closed'],
    ['failed', 're-login of a.test failed'],
    ['cancelled', 'the re-login of a.test was cancelled'],
  ] as const)('ends %s with exit 2', async (state, text) => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server);
    server.onPoll = (poll) => {
      if (poll === 1) server.relogin = finished(server, state, { error: 'window_closed' });
    };
    const result = await run(server, [...LOGIN, ...URL_FLAGS]);
    expect(result.code).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain(text);
  });

  it('cancels the re-login at --timeout (2) and on Ctrl+C (1)', async () => {
    const timed = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(timed);
    const late = await run(timed, [...LOGIN, '--timeout', '5s', ...URL_FLAGS]);
    expect(late.code).toBe(2);
    expect(paths(timed).at(-1)).toBe(`DELETE ${RELOGIN}?requested_at=1`);
    expect(late.stderr).toContain(
      'Timed out after 5s: the re-login of a.test was cancelled and its window closed.',
    );

    const stopped = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(stopped);
    const op = operator();
    stopped.onPoll = (poll) => {
      if (poll === 1) op.interrupt();
    };
    const result = await run(stopped, [...LOGIN, ...URL_FLAGS], { op });
    expect(result.code).toBe(1);
    expect(paths(stopped).at(-1)).toBe(`DELETE ${RELOGIN}?requested_at=1`);
    expect(result.stderr).toContain('Stopped: the re-login of a.test was cancelled');
  });

  it('a re-login someone started after this one is neither followed nor cancelled (1)', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server);
    server.onPoll = (poll) => {
      if (poll === 1 && server.relogin !== null) {
        server.relogin = view({ ...server.relogin, requested_at: 2, requested_by: 'op2' });
      }
    };
    const result = await run(server, [...LOGIN, ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('another re-login of job-hunt replaced this one');
    expect(paths(server).some((p) => p.startsWith('DELETE'))).toBe(false);
  });

  it('a refused start is an API error (1)', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    server.routes = (method, path) =>
      method === 'POST' && path === RELOGIN
        ? [409, problem(409, 'CONFLICT', 'a recording is open on this template')]
        : undefined;
    const result = await run(server, [...LOGIN, ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[CONFLICT] a recording is open on this template');
  });

  it('a re-login the server no longer knows ends with 1', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server);
    server.onPoll = (poll) => {
      if (poll === 1) server.relogin = null;
    };
    const result = await run(server, [...LOGIN, ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is no longer known to the server');
  });

  it('--json prints the finished re-login only', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server);
    server.onPoll = (poll) => {
      if (poll === 1) server.relogin = finished(server, 'failed', { error: 'still_signed_out' });
    };
    const result = await run(server, [...LOGIN, '--json', ...URL_FLAGS]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      session_id: null,
      relogin: { site_id: 'a.test', state: 'failed', error: 'still_signed_out' },
    });
  });
});

describe('templates login: vault', () => {
  it('fills in the background, never reads Enter, and points at Allow this template on failure (2)', async () => {
    const server = fakeServer({ 'a.test': 'signed_out' });
    withRelogin(server, { state: 'filling', deadline_at: null, agents_paused: false });
    const op = operator();
    server.onPoll = (poll) => {
      if (poll === 1) op.enter();
      if (poll === 2) server.relogin = finished(server, 'failed', { error: 'not_authorized' });
    };
    const result = await run(
      server,
      [...LOGIN, '--method', 'vault', '--url', 'http://bh.example:9876'],
      { op },
    );
    expect(result.code).toBe(2);
    expect(server.calls.find((c) => c.path === RELOGIN)?.body).toEqual({
      site_id: 'a.test',
      method: 'vault',
      let_agents_continue: false,
    });
    expect(paths(server).filter((p) => p.endsWith('/confirm'))).toEqual([]);
    expect(result.stderr).not.toContain('This opens a window');
    expect(result.stdout).toContain(
      'BrowserHive is filling the vault login linked to a.test into its sign-in page, in a background window on hive-box.',
    );
    expect(result.stdout).not.toContain('Press Enter');
    expect(result.stdout).toContain('re-login of a.test failed');
    expect(result.stdout).toContain('not_authorized');
    expect(result.stderr).toContain('(Allow this template)');
  });
});

function probeResult(site: string, outcome: ProbeResult['outcome'], reason: string): ProbeResult {
  return { site_id: site, outcome, reason, duration_ms: 40 };
}

function withProbe(server: FakeServer, results: readonly ProbeResult[]): void {
  server.routes = (method, path) =>
    method === 'POST' && path === `${BASE}/${ID}/probe` ? [200, { results }] : undefined;
}

describe('templates probe', () => {
  it('checks every site and prints one line each (0 when all are signed in)', async () => {
    const server = fakeServer({ 'a.test': 'signed_in', 'bb.test': 'signed_in' });
    withProbe(server, [
      probeResult('a.test', 'signed_in', 'learned_cookies'),
      { ...probeResult('bb.test', 'signed_in', 'learned_cookies'), duration_ms: 1500 },
    ]);
    const result = await run(server, ['probe', 'job-hunt', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(paths(server)).toEqual([LIST, `POST ${BASE}/${ID}/probe`]);
    expect(server.calls[1]?.body).toEqual({});
    expect(result.stdout).toContain('Checking the sites of job-hunt…');
    expect(result.stdout).toContain(
      'a.test   ✓ signed in  every sign-in cookie is there (learned_cookies)  40 ms',
    );
    expect(result.stdout).toContain('bb.test  ✓ signed in');
    expect(result.stdout).toContain('1.5 s');
    expect(result.stdout).not.toContain('templates login');
  });

  it('--site checks one site; signed out exits 2 with the login command', async () => {
    const server = fakeServer({ 'a.test': 'signed_in', 'b.test': 'signed_in' });
    withProbe(server, [probeResult('b.test', 'signed_out', 'cookies_absent')]);
    const result = await run(server, ['probe', 'job-hunt', '--site', 'b.test', ...URL_FLAGS]);
    expect(result.code).toBe(2);
    expect(server.calls[1]?.body).toEqual({ site_ids: ['b.test'] });
    expect(result.stdout).toContain('b.test  ✗ signed out  no sign-in cookie is left');
    expect(result.stdout).toContain(
      'Sign in to b.test again: browserhive templates login job-hunt --site b.test',
    );
  });

  it('inconclusive results exit 2: no learned names point at login, partial cookies at a look', async () => {
    const server = fakeServer({ 'a.test': 'signed_in', 'b.test': 'signed_in' });
    withProbe(server, [
      probeResult('a.test', 'inconclusive', 'no_pack'),
      probeResult('b.test', 'inconclusive', 'partial_cookies'),
    ]);
    const result = await run(server, ['probe', 'job-hunt', ...URL_FLAGS]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("a.test  ? couldn't tell  no sign-in cookies learned yet");
    expect(result.stdout).toContain('Sign in to a.test again');
    expect(result.stdout).not.toContain('Sign in to b.test again');
    expect(result.stdout).toContain("BrowserHive couldn't tell for some sites.");
  });

  it('--json prints the results with the same exit code', async () => {
    const server = fakeServer({ 'a.test': 'signed_in' });
    const results = [probeResult('a.test', 'signed_out', 'cookies_absent')];
    withProbe(server, results);
    const result = await run(server, ['probe', 'job-hunt', '--json', ...URL_FLAGS]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ results });
  });

  it('an unknown site, an invalid one and an API error', async () => {
    const server = fakeServer({ 'a.test': 'signed_in' });
    const unknown = await run(server, ['probe', 'job-hunt', '--site', 'z.test', ...URL_FLAGS]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("has no site 'z.test'");
    const invalid = await run(server, ['probe', 'job-hunt', '--site', 'not a site', ...URL_FLAGS]);
    expect(invalid.code).toBe(64);
    server.routes = (method, path) =>
      method === 'POST' && path.endsWith('/probe')
        ? [503, problem(503, 'TEMPLATE_UNAVAILABLE', 'starting')]
        : undefined;
    const failed = await run(server, ['probe', 'job-hunt', ...URL_FLAGS]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('[TEMPLATE_UNAVAILABLE]');
  });
});

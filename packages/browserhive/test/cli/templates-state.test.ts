/** @module test/cli/templates-state.test — `browserhive templates seed | restore` and `templates create --fromState` (spec 13 §3.12, §7.4, §11.5): local checks of the state file, the typed-name confirmation and its refusal without a terminal, the operation poll, and the exit codes. */

import { describe, expect, it } from 'bun:test';
import { TEMPLATE_SEED_MAX_BYTES } from '@browserhive/contracts/http';
import { cliHarness, type HarnessResult, MemoryFs } from './helpers.ts';
import {
  BASE,
  type FakeServer,
  fakeServer,
  http,
  ID,
  operator,
  paths,
  problem,
  URL_FLAGS,
} from './template-fakes.ts';

const OP = 'op-abcdefghijkl';
const STATE = {
  cookies: [{ name: 'li_at', value: 'v', domain: '.linkedin.com', path: '/', expires: -1 }],
  origins: [{ origin: 'https://www.linkedin.com', localStorage: [] }],
};

/** Operation routes: the start answers 202, the poll answers `running` `runningPolls` times. */
function withOperation(
  server: FakeServer,
  options: { kind: 'seed' | 'restore'; runningPolls?: number; error?: string; version?: number },
): void {
  let polls = 0;
  server.routes = (method, path) => {
    const starts =
      (options.kind === 'seed' && method === 'POST' && path.startsWith(`${BASE}/${ID}/state`)) ||
      (options.kind === 'restore' && method === 'POST' && path.endsWith('/restore'));
    if (starts) return [202, { operation_id: OP }];
    if (method === 'GET' && path === `${BASE}/operations/${OP}`) {
      polls += 1;
      const running = polls <= (options.runningPolls ?? 0);
      if (!running && options.kind === 'seed') server.status = 'ready';
      return [
        200,
        {
          operation_id: OP,
          kind: options.kind,
          state: running ? 'running' : options.error === undefined ? 'done' : 'failed',
          template_id: ID,
          ...(!running && options.version !== undefined && { version: options.version }),
          ...(!running &&
            options.error !== undefined && {
              error: { code: options.error, message: 'the key is missing' },
            }),
          closed_sessions: running ? [] : ['s-1'],
          started_at: 1,
          finished_at: running ? null : 2,
        },
      ];
    }
    return undefined;
  };
}

async function cli(
  server: FakeServer,
  argv: readonly string[],
  options: { fs?: MemoryFs; answers?: string[]; op?: ReturnType<typeof operator> } = {},
): Promise<HarnessResult> {
  const op = options.op ?? operator();
  return cliHarness({
    argv: ['templates', ...argv, ...URL_FLAGS],
    http: http(server),
    wait: op.wait,
    overrides: { clock: op.clock },
    fs: options.fs ?? new MemoryFs({ '/work/state.json': JSON.stringify(STATE) }),
    ...(options.answers !== undefined && { answers: options.answers }),
  });
}

describe('templates seed', () => {
  it('asks for the name, sends the file as the body with confirm=true and polls every second', async () => {
    const server = fakeServer({ 'linkedin.com': 'signed_in' });
    server.status = 'ready';
    withOperation(server, { kind: 'seed', runningPolls: 2, version: 5 });
    const op = operator();
    const result = await cli(server, ['seed', 'job-hunt', 'state.json'], {
      answers: ['job-hunt'],
      op,
    });
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual(["Type the template's name to confirm: "]);
    expect(result.stdout).toContain('with /work/state.json: 1 cookie(s), 1 origin(s)');
    expect(result.stdout).toContain('seeded job-hunt as version 5');
    const start = server.calls.find((c) => c.method === 'POST');
    expect(start?.path).toBe(`${BASE}/${ID}/state?confirm=true`);
    expect(start?.body).toEqual(STATE);
    expect(op.slept).toEqual([1000, 1000]);
    expect(paths(server).filter((p) => p.includes('/operations/'))).toHaveLength(3);
  });

  it('exits 2 when a site is signed out afterwards', async () => {
    const server = fakeServer({ 'linkedin.com': 'signed_in', 'indeed.com': 'signed_out' });
    withOperation(server, { kind: 'seed' });
    const result = await cli(server, ['seed', 'job-hunt', '/work/state.json', '--yes']);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('indeed.com is not signed in');
  });

  it('refuses without a terminal unless --yes, and a wrong name aborts', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    withOperation(server, { kind: 'seed' });
    const refused = await cli(server, ['seed', 'job-hunt', 'state.json']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('refusing without confirmation, and stdin is not a terminal');
    const aborted = await cli(server, ['seed', 'job-hunt', 'state.json'], { answers: ['nope'] });
    expect(aborted.code).toBe(1);
    expect(aborted.stdout).toContain('Aborted — nothing was changed.');
    expect(server.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('checks the file locally: missing, too large, not JSON, not a storage state', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    const missing = await cli(server, ['seed', 'job-hunt', 'gone.json', '--yes']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('/work/gone.json does not exist or is not a file.');
    const big = new MemoryFs({ '/work/big.json': 'x'.repeat(TEMPLATE_SEED_MAX_BYTES + 1) });
    const tooBig = await cli(server, ['seed', 'job-hunt', 'big.json', '--yes'], { fs: big });
    expect(tooBig.code).toBe(1);
    expect(tooBig.stderr).toContain('a storage state may be at most');
    const text = new MemoryFs({ '/work/s.json': 'cookie=1' });
    const notJson = await cli(server, ['seed', 'job-hunt', 's.json', '--yes'], { fs: text });
    expect(notJson.stderr).toContain('is not JSON');
    const shape = new MemoryFs({ '/work/s.json': JSON.stringify({ cookies: [{ name: 'a' }] }) });
    const wrong = await cli(server, ['seed', 'job-hunt', 's.json', '--yes'], { fs: shape });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('is not a Playwright storage state at cookies.0');
    expect(server.calls).toEqual([]);
  });

  it('a failed operation prints its code and exits 1', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    withOperation(server, { kind: 'seed', error: 'TEMPLATE_KEY_MISSING' });
    const result = await cli(server, ['seed', 'job-hunt', 'state.json', '--yes']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('seeding failed: [TEMPLATE_KEY_MISSING] the key is missing');
  });

  it('Ctrl+C stops waiting and names the operation that goes on', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    withOperation(server, { kind: 'seed', runningPolls: 1_000 });
    const op = operator();
    const sleep = op.wait.sleep;
    op.wait.sleep = async (ms) => {
      await sleep(ms);
      op.interrupt();
      return new Promise<void>(() => undefined);
    };
    const result = await cli(server, ['seed', 'job-hunt', 'state.json', '--yes'], { op });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`the seeding continues on the server (operation ${OP})`);
  });
});

describe('templates restore', () => {
  it('confirms by name, posts the version and waits for the operation', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    withOperation(server, { kind: 'restore', runningPolls: 1, version: 7 });
    const result = await cli(server, ['restore', 'job-hunt', '3'], { answers: ['job-hunt'] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("This restores template 'job-hunt' to version 3");
    expect(result.stdout).toContain('No session is using it.');
    expect(result.stdout).toContain('restored job-hunt to version 3 as version 7');
    expect(result.stdout).toContain('1 session(s) closed');
    const start = server.calls.find((c) => c.method === 'POST');
    expect(start).toEqual({ method: 'POST', path: `${BASE}/${ID}/versions/3/restore`, body: {} });
  });

  it('latest with --forceClose --yes sends force_close; --json prints the operation', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    withOperation(server, { kind: 'restore', version: 8 });
    const result = await cli(server, [
      'restore',
      'job-hunt',
      'latest',
      '--forceClose',
      '--yes',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(server.calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: `${BASE}/${ID}/versions/latest/restore`,
      body: { force_close: true },
    });
    expect((JSON.parse(result.stdout) as { version: number }).version).toBe(8);
  });

  it('an unreadable version (409) or a failed operation exits 1; a bad version is 64', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    server.routes = (method, path) =>
      method === 'POST' && path.endsWith('/restore')
        ? [409, problem(409, 'TEMPLATE_VERSION_UNREADABLE', 'Version 2 cannot be read.')]
        : undefined;
    const refused = await cli(server, ['restore', 'job-hunt', '2', '--yes']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('[TEMPLATE_VERSION_UNREADABLE] Version 2 cannot be read.');
    withOperation(server, { kind: 'restore', error: 'TEMPLATE_UNAVAILABLE' });
    const failed = await cli(server, ['restore', 'job-hunt', '2', '--yes']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('restore failed: [TEMPLATE_UNAVAILABLE]');
    const usage = await cli(server, ['restore', 'job-hunt', 'v2']);
    expect(usage.code).toBe(64);
    expect(usage.stderr).toContain("invalid version 'v2'");
  });

  it('refuses without a terminal unless --yes', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    withOperation(server, { kind: 'restore' });
    const result = await cli(server, ['restore', 'job-hunt', '1']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'browserhive templates restore: refusing without confirmation, and stdin is not a terminal.',
    );
    expect(server.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});

describe('templates create --fromState', () => {
  it('creates, then seeds instead of opening a sign-in window', async () => {
    const server = fakeServer({ 'linkedin.com': 'signed_in' });
    withOperation(server, { kind: 'seed', version: 1 });
    const result = await cli(server, [
      'create',
      'job-hunt',
      '--sites',
      'linkedin.com',
      '--fromState',
      'state.json',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`created template job-hunt (${ID})`);
    expect(result.stdout).toContain('seeded job-hunt as version 1');
    expect(paths(server).some((p) => p.endsWith('/recording'))).toBe(false);
    expect(paths(server)).toContain(`POST ${BASE}/${ID}/state?confirm=true`);
  });

  it('refuses a bad file before creating anything; --noLogin with --fromState is 64', async () => {
    const server = fakeServer({ 'a.com': 'signed_in' });
    const bad = await cli(server, [
      'create',
      'job-hunt',
      '--sites',
      'a.com',
      '--fromState',
      'x.json',
    ]);
    expect(bad.code).toBe(1);
    expect(server.calls).toEqual([]);
    const both = await cli(server, [
      'create',
      'job-hunt',
      '--sites',
      'a.com',
      '--fromState',
      'state.json',
      '--noLogin',
    ]);
    expect(both.code).toBe(64);
    expect(both.stderr).toContain('--fromState and --noLogin are mutually exclusive');
  });
});

/** @module test/cli/run — version output, serve hand-off and stdio discipline, boot error mapping, `admin tokens --url`, output module (colour rules, tables, status lines) */
import { describe, expect, it } from 'bun:test';
import { AppError } from '@browserhive/core/kernel';
import type { CliDeps } from '../../src/cli/deps.ts';
import { captureOutput } from '../../src/cli/output/output.ts';
import { resolveColorEnabled } from '../../src/cli/output/style.ts';
import { renderTable } from '../../src/cli/output/text.ts';
import { cliHarness, probeState, storageState } from './helpers.ts';

describe('version', () => {
  it('--version, -v and version print the one-line format', async () => {
    const line =
      'browserhive 0.1.0 (bun 1.4.2, sqlite 3.53.2, playwright 1.63.0, patchright 1.63.0)\n';
    for (const argv of [['--version'], ['-v'], ['version']]) {
      const run = await cliHarness({ argv });
      expect(run.code).toBe(0);
      expect(run.stdout).toBe(line);
    }
  });

  it('patchright not installed; --json for machines', async () => {
    const probes = probeState({
      patchright: { packageVersion: null, executablePath: null, installed: false },
    });
    const run = await cliHarness({ argv: ['version'], probes });
    expect(run.stdout).toBe(
      'browserhive 0.1.0 (bun 1.4.2, sqlite 3.53.2, playwright 1.63.0, patchright not installed)\n',
    );
    const json = await cliHarness({ argv: ['version', '--json'], probes });
    expect(JSON.parse(json.stdout)).toEqual({
      browserhive: '0.1.0',
      bun: '1.4.2',
      sqlite: '3.53.2',
      playwright: '1.63.0',
      patchright: null,
      schema_version: 1,
    });
  });
});

describe('serve', () => {
  it('hands the resolved config to bootServer and exits with done', async () => {
    const run = await cliHarness({
      argv: ['--port', '9001', '--admin'],
      boot: async (input) => {
        input.output.stdout(' BrowserHive 0.1.0');
        return {
          url: 'http://127.0.0.1:9001',
          transport: 'http',
          stop: async () => undefined,
          done: Promise.resolve(0),
        };
      },
    });
    expect(run.code).toBe(0);
    expect(run.boots).toHaveLength(1);
    const boot = run.boots[0];
    expect(boot?.resolved.config.port).toBe(9001);
    expect(boot?.installProcessHandlers).toBe(true);
    expect(boot?.appVersion).toBe('0.1.0');
    expect(run.stdout).toBe(' BrowserHive 0.1.0\n');
  });

  it('the exit code of done is returned (130 after a forced stop)', async () => {
    const run = await cliHarness({
      argv: [],
      boot: async () => ({
        url: null,
        transport: 'http',
        stop: async () => undefined,
        done: Promise.resolve(130),
      }),
    });
    expect(run.code).toBe(130);
  });

  it('stdio mode routes every CLI line to stderr', async () => {
    const run = await cliHarness({
      argv: ['--transport', 'stdio'],
      boot: async (input) => {
        input.output.stdout('banner line');
        input.output.stderr('log line');
        return {
          url: null,
          transport: 'stdio',
          stop: async () => undefined,
          done: Promise.resolve(0),
        };
      },
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('banner line\nlog line\n');
    expect(run.boots[0]?.output.isTty.stdout).toBe(false);
  });

  it('a boot AppError maps to its registry exit code with [CODE] message and hint, no stack', async () => {
    const run = await cliHarness({
      argv: ['--port', '9001'],
      boot: async () => {
        throw new AppError(
          'PORT_IN_USE',
          { host: '127.0.0.1', port: 9001, errno: 'EADDRINUSE' },
          { publicMessage: 'Port 9001 on 127.0.0.1 is already in use.' },
        );
      },
    });
    expect(run.code).toBe(3);
    expect(run.stderr).toBe(
      'browserhive: [PORT_IN_USE] Port 9001 on 127.0.0.1 is already in use.\nhint: Pick another port with --port, or stop the process holding it.\n',
    );
  });

  it('a stack is printed only with --logLevel debug', async () => {
    const boot = async (): Promise<never> => {
      throw new AppError('DB_CORRUPT', { path: '/x', quarantine_path: '/x.corrupt' });
    };
    const quiet = await cliHarness({ argv: [], boot });
    expect(quiet.code).toBe(1);
    expect(quiet.stderr).not.toContain('    at ');
    const loud = await cliHarness({ argv: ['--logLevel', 'debug'], boot });
    expect(loud.stderr).toContain('    at ');
  });

  it('a non-AppError is fatal (1) with a hint', async () => {
    const run = await cliHarness({
      argv: [],
      boot: async () => {
        throw new Error('kaboom');
      },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(
      "browserhive: fatal: kaboom\nRe-run with --logLevel debug for the stack trace, or run 'browserhive doctor'.\n",
    );
  });
});

describe('admin tokens (fake storage and REST)', () => {
  it('local create/list/revoke; reset-password refuses while running', async () => {
    const storage = storageState();
    const create = await cliHarness({ argv: ['admin', 'tokens', 'create', 'agent-2'], storage });
    expect(create.code).toBe(0);
    expect(create.stdout).toContain(`token:   bh_agent_${'A'.repeat(43)}`);
    const list = await cliHarness({ argv: ['admin', 'tokens', 'list', '--json'], storage });
    expect(JSON.parse(list.stdout)).toMatchObject([
      { subject: 'agent-2', public_prefix: 'pre1xxxx' },
    ]);
    const revoke = await cliHarness({ argv: ['admin', 'tokens', 'revoke', 'agent-2'], storage });
    expect(revoke.code).toBe(0);
    expect(storage.tokens).toEqual([]);
    const locked = await cliHarness({
      argv: ['admin', 'reset-password'],
      storage,
      lock: { pid: 5, owner: 'serve', startedAt: 1 },
    });
    expect(locked.code).toBe(3);
    expect(storage.resets).toBe(0);
    expect(storage.opened.some((o) => o.owner === 'admin reset-password')).toBe(false);
    const reset = await cliHarness({ argv: ['admin', 'reset-password'], storage });
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain('password: Kq7-generated-password-24');
  });

  it('--url goes through the REST API with the bearer and never opens the database', async () => {
    const calls: {
      url: string;
      method: string;
      headers: Readonly<Record<string, string>>;
      body?: string;
    }[] = [];
    const rows = [
      {
        credential_id: 'c1',
        public_prefix: 'abcd1234',
        owner_kind: 'agent',
        subject: 'agent-2',
        scopes: ['mcp:tools'],
        created_at: 1_758_000_000_000,
        last_used_at: null,
        expires_at: null,
      },
    ];
    const http: CliDeps['http'] = async (url, init) => {
      calls.push({ url, ...init });
      const body =
        init.method === 'POST'
          ? { credential_id: 'c1', token: `bh_agent_${'B'.repeat(43)}` }
          : init.method === 'GET'
            ? { data: rows }
            : null;
      return {
        status: init.method === 'DELETE' ? 204 : 200,
        json: async () => body,
        text: async () => (body === null ? '' : JSON.stringify(body)),
      };
    };
    const storage = storageState();
    const base = ['--url', 'http://127.0.0.1:9876', '--token', 'bh_operator_x'];
    const create = await cliHarness({
      argv: ['admin', 'tokens', 'create', 'agent-2', ...base],
      storage,
      http,
      lock: { pid: 1, owner: 'serve', startedAt: 1 },
    });
    expect(create.code).toBe(0);
    expect(create.stdout).toContain(`bh_agent_${'B'.repeat(43)}`);
    const revoke = await cliHarness({
      argv: ['admin', 'tokens', 'revoke', 'agent-2', ...base],
      storage,
      http,
    });
    expect(revoke.code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://127.0.0.1:9876/api/v1/auth/tokens',
      'GET http://127.0.0.1:9876/api/v1/auth/tokens',
      'GET http://127.0.0.1:9876/api/v1/auth/tokens',
      'DELETE http://127.0.0.1:9876/api/v1/auth/tokens/c1',
    ]);
    expect(calls[0]?.headers['authorization']).toBe('Bearer bh_operator_x');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ owner_kind: 'agent', display: 'agent-2' });
    expect(storage.opened).toEqual([]);
  });

  it('REST problem+json errors are rendered with code and hint', async () => {
    const http: CliDeps['http'] = async () => ({
      status: 401,
      json: async () => ({}),
      text: async () =>
        JSON.stringify({
          type: 'x',
          title: 'Unauthorized',
          status: 401,
          code: 'UNAUTHORIZED',
          retryable: 'never',
        }),
    });
    const run = await cliHarness({
      argv: ['admin', 'tokens', 'list', '--url', 'http://h:1', '--cookie', 'c'],
      http,
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('[UNAUTHORIZED] Unauthorized');
    expect(run.stderr).toContain('--token');
  });
});

describe('output module', () => {
  it.each([
    ['always', {}, false, true],
    ['never', { FORCE_COLOR: '1' }, true, false],
    ['auto', {}, true, true],
    ['auto', {}, false, false],
    ['auto', { NO_COLOR: '1' }, true, false],
    ['auto', { FORCE_COLOR: '1' }, false, true],
    ['auto', { FORCE_COLOR: '0' }, true, true],
    ['auto', { TERM: 'dumb' }, true, false],
  ] as const)('color=%s env=%p tty=%p → %p', (mode, env, tty, expected) => {
    expect(resolveColorEnabled(mode, env, tty)).toBe(expected);
  });

  it('tables align columns, never pad the last one, and measure ANSI-free width', () => {
    expect(
      renderTable(
        [{ header: 'A' }, { header: 'SIZE', align: 'right' }, { header: 'NOTE' }],
        [
          ['\x1b[1mlong-name\x1b[22m', '1 B', 'x'],
          ['b', '1.2 MB', ''],
        ],
      ),
    ).toEqual([
      'A            SIZE  NOTE',
      '\x1b[1mlong-name\x1b[22m     1 B  x',
      'b          1.2 MB',
    ]);
  });

  it('status lines, JSON, and stdio re-targeting', () => {
    const plain = captureOutput();
    plain.output.status('ok', 'done', 'detail');
    plain.output.status('fail', 'broken');
    plain.output.status('warn', 'careful');
    plain.output.json({ a: 1 });
    expect(plain.stdout()).toBe('✓ done  detail\n✗ broken\n! careful\n{\n  "a": 1\n}\n');
    const stdio = captureOutput().output;
    const captured = captureOutput({ stdio: true });
    captured.output.line('to stderr');
    captured.output.sinks().stdout('sink line');
    expect(captured.stdout()).toBe('');
    expect(captured.stderr()).toBe('to stderr\nsink line\n');
    expect(stdio.forStdio()).not.toBe(stdio);
  });
});

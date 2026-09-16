/** @module test/cli/plan — `planCli` precedence table: help > version > unknown flags (64) > command > stray flags (64) > config (64) > policy guards (3) > run */
import { describe, expect, it } from 'bun:test';
import type { CliPlan } from '../../src/cli/invocation.ts';
import { planCli } from '../../src/cli/plan.ts';
import { DATA_DIR, fakeHost, MemoryFs } from './helpers.ts';

function plan(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  files: Record<string, string> = {},
): CliPlan {
  const fs = new MemoryFs(files);
  return planCli(argv, env, fs.configFs(), {
    cwd: '/work',
    host: fakeHost({ env }),
    knownLogModules: ['sessions', 'http'],
  });
}

function exitOf(result: CliPlan): { code: number; text: string } {
  if (result.kind !== 'exit') throw new Error(`expected exit, got ${result.kind}`);
  return { code: result.code, text: result.lines.join('\n') };
}

function commandOf(result: CliPlan): string {
  if (result.kind !== 'run') throw new Error(`expected run, got ${JSON.stringify(result)}`);
  return result.invocation.command;
}

describe('planCli precedence', () => {
  it.each([
    [['--help']],
    [['-h']],
    [['--bogus', '--help']],
    [['--help', '--version']],
    [['--host', '0.0.0.0', '--help']],
    [['--port', 'nope', '--help']],
  ])('%p → help wins', (argv) => {
    expect(plan(argv).kind).toBe('help');
  });

  it('per-command help beats stray and unknown flags', () => {
    const result = plan(['purge', '--port', '1', '--bogus', '--help']);
    expect(result).toEqual({
      kind: 'help',
      topic: { command: 'purge', subcommand: null },
      color: 'auto',
    });
  });

  it('subcommand help and the help command', () => {
    expect(plan(['db', 'restore', '--help'])).toMatchObject({
      kind: 'help',
      topic: { command: 'db', subcommand: ['restore'] },
    });
    expect(plan(['help', 'admin', 'tokens', 'create'])).toMatchObject({
      kind: 'help',
      topic: { command: 'admin', subcommand: ['tokens', 'create'] },
    });
    expect(plan(['help'])).toMatchObject({ kind: 'help', topic: { command: null } });
  });

  it.each([
    [['--version']],
    [['-v']],
    [['-v', '--bogus']],
    [['purge', '--port', '1', '--version']],
  ])('%p → version beats errors', (argv) => {
    expect(plan(argv).kind).toBe('version');
  });

  it('unknown flag (64) with the exact spec message', () => {
    expect(exitOf(plan(['--maxSession', '3']))).toEqual({
      code: 64,
      text: "browserhive: unknown flag '--maxSession'. Did you mean '--maxSessions'? Run 'browserhive --help'.",
    });
  });

  it('every unknown flag is reported, not just the first', () => {
    const { code, text } = exitOf(plan(['--maxSession', '3', '--prot', '9000']));
    expect(code).toBe(64);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain("'--port'");
  });

  it.each([
    [['--max-sessions', '2'], "Did you mean '--maxSessions'?"],
    [['--data-dir', '/x'], "Did you mean '--dataDir'?"],
    [['--pretty-logs'], "Did you mean '--logFormat'?"],
    [
      ['--admin-port', '9877'],
      'This option is not supported: the dashboard shares --host and --port.',
    ],
    [['purge', '--dry-run'], "Did you mean '--dryRun'? Run 'browserhive purge --help'."],
    [
      ['db', 'migrate', '--dry-run'],
      "Did you mean '--dryRun'? Run 'browserhive db migrate --help'.",
    ],
    [['doctr'], "unknown command 'doctr'. Did you mean 'doctor'?"],
    [['-x'], "unknown flag '-x'."],
  ])('unsupported and misspelt spelling %p hints the supported flag', (argv, hint) => {
    const { code, text } = exitOf(plan(argv));
    expect(code).toBe(64);
    expect(text).toContain(hint);
  });

  it('unknown flags win over stray flags', () => {
    const { text } = exitOf(plan(['purge', '--bogus', '--port', '1']));
    expect(text).toContain("unknown flag '--bogus'");
    expect(text).not.toContain('--port');
  });

  it('command errors: missing subcommand, unknown subcommand, missing argument, extra argument', () => {
    expect(exitOf(plan(['db']))).toEqual({
      code: 64,
      text: "browserhive: 'db' requires a subcommand: status, backup, restore, migrate. Run 'browserhive db --help'.",
    });
    expect(exitOf(plan(['db', 'restore']))).toEqual({
      code: 64,
      text: "browserhive: 'db restore' requires a file argument.",
    });
    expect(exitOf(plan(['db', 'vacuum'])).text).toContain("unknown subcommand 'vacuum' for 'db'");
    expect(exitOf(plan(['admin', 'tokens'])).text).toContain(
      "'admin tokens' requires a subcommand: list, create, revoke.",
    );
    expect(exitOf(plan(['--admin', 'serve'])).text).toBe(
      "browserhive: unexpected argument 'serve'. Run 'browserhive --help'.",
    );
    expect(exitOf(plan(['version', 'extra'])).code).toBe(64);
  });

  it('a space-separated value after a boolean flag names the accepted spellings', () => {
    expect(exitOf(plan(['--admin', '--humanize', 'true']))).toEqual({
      code: 64,
      text: 'browserhive: --humanize is a boolean flag and takes no separate value: use --humanize or --humanize=true.',
    });
    expect(exitOf(plan(['--admin', 'FALSE'])).text).toBe(
      'browserhive: --admin is a boolean flag and takes no separate value: use --admin or --admin=false.',
    );
    // A non-boolean word after a boolean flag keeps the generic message.
    expect(exitOf(plan(['--admin', 'serve'])).text).toContain("unexpected argument 'serve'");
  });

  it('stray flags (64): a server flag on purge, a purge flag on serve', () => {
    expect(exitOf(plan(['purge', '--port', '9000']))).toEqual({
      code: 64,
      text: "browserhive: --port is not accepted by 'browserhive purge'. Run 'browserhive purge --help'.",
    });
    expect(exitOf(plan(['--all']))).toEqual({
      code: 64,
      text: "browserhive: --all only applies to 'browserhive purge'. Run 'browserhive --help'.",
    });
  });

  it('stray flags win over invalid config values', () => {
    const { text } = exitOf(plan(['--all', '--port', 'abc']));
    expect(text).toContain('--all only applies');
    expect(text).not.toContain('invalid value');
  });

  it('missing flag value (64)', () => {
    expect(exitOf(plan(['--port']))).toEqual({
      code: 64,
      text: 'browserhive: --port requires a value.',
    });
  });

  it('config errors (64)', () => {
    expect(exitOf(plan(['--sessionLease', '2 hours']))).toEqual({
      code: 64,
      text: "browserhive: invalid value for --sessionLease: '2 hours'. Expected a duration like '2h', '30m', '90s', '500ms', or an integer of milliseconds.",
    });
    expect(exitOf(plan([], { BROWSERHIVE_PORT: '' }))).toEqual({
      code: 64,
      text: 'browserhive: BROWSERHIVE_PORT is set but empty. Unset it or provide a value.',
    });
    expect(exitOf(plan(['--config', '/nope.json'])).code).toBe(64);
    expect(exitOf(plan(['--logLevel', 'info,nosuch=debug'])).code).toBe(64);
    expect(exitOf(plan(['admin', 'tokens', 'list', '--token', 'abc'])).text).toBe(
      'browserhive: --token requires --url.',
    );
    expect(exitOf(plan(['admin', 'tokens', 'create', 'a', '--expiresIn', 'soon'])).code).toBe(64);
    expect(exitOf(plan(['init', '--browsers', 'firefox'])).text).toContain(
      'Expected one of: chromium.',
    );
  });

  it('config errors (64) win over policy guards (3)', () => {
    expect(exitOf(plan(['--host', '0.0.0.0', '--sessionLease', 'x'])).code).toBe(64);
  });

  it('policy guards (3) print [CODE] message', () => {
    expect(exitOf(plan(['--host', '0.0.0.0']))).toEqual({
      code: 3,
      text: 'browserhive: [INSECURE_BIND_REFUSED] Refusing to bind 0.0.0.0 without authentication. Set auth=token, or set allowInsecureBind=true to accept the risk.',
    });
    const admin = exitOf(plan(['--transport', 'stdio', '--admin']));
    expect(admin.code).toBe(3);
    expect(admin.text).toContain('[ADMIN_REQUIRES_HTTP]');
    expect(exitOf(plan(['config', 'validate', '--host', '0.0.0.0'])).code).toBe(3);
  });

  it('runs: serve (default), stdio discipline flag, colour from flags', () => {
    const serve = plan([]);
    expect(commandOf(serve)).toBe('serve');
    expect(serve).toMatchObject({ stdio: false, color: 'auto' });
    expect(plan(['serve', '--transport', 'stdio', '--color', 'never'])).toMatchObject({
      kind: 'run',
      stdio: true,
      color: 'never',
    });
    expect(plan(['--noAdmin', '--port=9000'])).toMatchObject({ kind: 'run' });
  });

  it('runs every command', () => {
    expect(commandOf(plan(['config']))).toBe('config-show');
    expect(commandOf(plan(['config', 'schema']))).toBe('config-schema');
    expect(commandOf(plan(['doctor', '--json', '--port', '9000']))).toBe('doctor');
    expect(commandOf(plan(['init', '--skipBrowsers']))).toBe('init');
    expect(commandOf(plan(['db', 'backup', '--out', 'b.db']))).toBe('db-backup');
    expect(commandOf(plan(['admin', 'reset-password']))).toBe('admin-reset-password');
    expect(commandOf(plan(['version', '--json']))).toBe('version');
    const create = plan([
      'admin',
      'tokens',
      'create',
      'agent-2',
      '--expiresIn',
      '30d',
      '--url',
      'http://127.0.0.1:9876/',
    ]);
    expect(create).toMatchObject({
      kind: 'run',
      invocation: {
        command: 'admin-tokens-create',
        principal: 'agent-2',
        expiresInMs: 30 * 86_400_000,
        remote: { url: 'http://127.0.0.1:9876' },
      },
    });
    expect(plan(['db', 'restore', 'old.db', '--yes'])).toMatchObject({
      invocation: { command: 'db-restore', file: '/work/old.db', yes: true },
    });
  });

  it('purge/db/admin resolve only the data dir, so unrelated invalid config never blocks them', () => {
    const result = plan(['purge', '--dryRun'], {
      BROWSERHIVE_PORT: 'abc',
      BROWSERHIVE_HOST: '0.0.0.0',
    });
    expect(result).toMatchObject({
      kind: 'run',
      invocation: { command: 'purge', dryRun: true, dataDir: DATA_DIR },
    });
    expect(plan(['db', 'status', '--dataDir', 'rel'])).toMatchObject({
      invocation: { dataDir: '/work/rel' },
    });
    const broken = plan(['purge'], {}, { '/work/browserhive.config.json': '{ nope' });
    expect(broken).toMatchObject({ kind: 'run', invocation: { dataDir: DATA_DIR } });
    expect(exitOf(plan(['purge'], { BROWSERHIVE_DATA_DIR: '' })).code).toBe(64);
  });

  it('doctor carries a config failure instead of exiting', () => {
    const result = plan(['doctor'], { BROWSERHIVE_PORT: 'abc' });
    expect(result).toMatchObject({
      kind: 'run',
      invocation: { command: 'doctor', dataDir: DATA_DIR },
    });
    if (result.kind === 'run' && result.invocation.command === 'doctor') {
      expect(result.invocation.resolution.ok).toBe(false);
    }
  });
});

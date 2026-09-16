/** @module test/cli/doctor — `browserhive doctor`: every check with injected probes, exit 0/1/2, `--json` shape */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { cliHarness, DATA_DIR, MemoryFs, probeState, storageState } from './helpers.ts';

const TOKEN = 'ci-runner:0123456789abcdef0123456789abcdef';

function healthyFs(): MemoryFs {
  const fs = new MemoryFs({ [`${DATA_DIR}/browserhive.db`]: 'db' });
  return fs;
}

const CheckRow = z.strictObject({
  check: z.string(),
  status: z.enum(['ok', 'warn', 'fail']),
  detail: z.string(),
});

async function doctorJson(options: Parameters<typeof cliHarness>[0]) {
  const run = await cliHarness({ ...options, argv: ['doctor', '--json', ...options.argv] });
  const rows = z.array(CheckRow).parse(JSON.parse(run.stdout));
  const byName = new Map(rows.map((row) => [row.check, row]));
  return { run, rows, byName };
}

describe('doctor', () => {
  it('all checks pass → exit 0; --json is an array of {check,status,detail}', async () => {
    const { run, rows } = await doctorJson({ argv: [], fs: healthyFs() });
    expect(run.code).toBe(0);
    expect(rows.map((r) => r.check)).toEqual([
      'bun',
      'config',
      'chromium (playwright)',
      'chromium (patchright)',
      'data dir',
      'port',
      'vault',
      'unrecognised data files',
      'database',
      'otel',
      'max sessions',
      'secrets',
    ]);
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('text mode prints a table, shadow lines and the summary', async () => {
    const run = await cliHarness({
      argv: ['doctor', '--maxSessions', '4'],
      env: { BROWSERHIVE_MAX_SESSIONS: '2' },
      fs: healthyFs(),
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^\s+CHECK\s+DETAIL/m);
    expect(run.stdout).toContain('✓  bun');
    expect(run.stdout).toContain('config: maxSessions=4 (cli) shadows env=2');
    expect(run.stdout).toContain('12 passed, 0 warnings, 0 failed');
  });

  it.each([
    ['bun too old', { probes: probeState({ bun: '1.3.9' }) }, 'bun', 'fail'],
    [
      'playwright chromium missing',
      {
        probes: probeState({
          playwright: { packageVersion: '1.63.0', executablePath: '/c/chrome', installed: false },
        }),
      },
      'chromium (playwright)',
      'fail',
    ],
    [
      'patchright missing under auto is a warning',
      {
        probes: probeState({
          patchright: { packageVersion: null, executablePath: null, installed: false },
        }),
      },
      'chromium (patchright)',
      'warn',
    ],
    ['port busy', { probes: probeState({ portFree: false }) }, 'port', 'fail'],
    [
      'data dir mode too broad',
      { probes: probeState({ modes: { [DATA_DIR]: 0o755 } }) },
      'data dir',
      'warn',
    ],
    ['low disk', { probes: probeState({ diskFree: 10_000 }) }, 'data dir', 'warn'],
    [
      'pending migrations',
      { storage: storageState({ pending: [{ version: 2, name: 'next' }] }) },
      'database',
      'warn',
    ],
    [
      'newer database',
      { storage: storageState({ userVersion: 3, minReaderVersion: 3 }) },
      'database',
      'fail',
    ],
    ['corrupt database', { storage: storageState({ quickCheckOk: false }) }, 'database', 'fail'],
    ['database cannot open', { openError: new Error('SQLITE_BUSY') }, 'database', 'fail'],
  ] as const)('%s', async (_name, overrides, check, status) => {
    const { run, byName } = await doctorJson({ argv: [], fs: healthyFs(), ...overrides });
    expect(byName.get(check)?.status).toBe(status);
    expect(run.code).toBe(status === 'fail' ? 1 : 2);
  });

  it('patchright required but missing is a failure', async () => {
    const { byName, run } = await doctorJson({
      argv: ['--stealthDriver', 'patchright'],
      fs: healthyFs(),
      probes: probeState({
        patchright: { packageVersion: null, executablePath: null, installed: false },
      }),
    });
    expect(byName.get('chromium (patchright)')?.status).toBe('fail');
    expect(run.code).toBe(1);
  });

  it('stealthDriver=playwright skips patchright', async () => {
    const { byName } = await doctorJson({
      argv: ['--stealthDriver', 'playwright'],
      fs: healthyFs(),
    });
    expect(byName.has('chromium (patchright)')).toBe(false);
  });

  it('port in use by our own running server is a warning', async () => {
    const { byName } = await doctorJson({
      argv: [],
      fs: healthyFs(),
      probes: probeState({ portFree: false }),
      lock: { pid: 99, owner: 'serve', startedAt: 1 },
    });
    expect(byName.get('port')?.status).toBe('warn');
  });

  it('vault=bitwarden requires bw on PATH', async () => {
    const missing = await doctorJson({ argv: ['--vault', 'bitwarden'], fs: healthyFs() });
    expect(missing.byName.get('vault')?.status).toBe('fail');
    const found = await doctorJson({
      argv: ['--vault', 'bitwarden'],
      fs: healthyFs(),
      probes: probeState({ bw: '/usr/bin/bw' }),
    });
    expect(found.byName.get('vault')).toEqual({
      check: 'vault',
      status: 'ok',
      detail: 'bw at /usr/bin/bw',
    });
  });

  it('an unrecognised events.db is a warning', async () => {
    const fs = healthyFs();
    fs.put(`${DATA_DIR}/events.db`, 'old');
    const { byName } = await doctorJson({ argv: [], fs });
    expect(byName.get('unrecognised data files')).toEqual({
      check: 'unrecognised data files',
      status: 'warn',
      detail: "unrecognised data file 'events.db' found; BrowserHive does not read or migrate it",
    });
  });

  it('OTLP unreachable is a warning only', async () => {
    const { byName, run } = await doctorJson({
      argv: ['--otel'],
      fs: healthyFs(),
      probes: probeState({ otlp: { ok: false, detail: 'timed out after 2000 ms' } }),
    });
    expect(byName.get('otel')?.status).toBe('warn');
    expect(run.code).toBe(2);
  });

  it('maxSessions unbounded or above RAM is a warning', async () => {
    expect(
      (await doctorJson({ argv: ['--maxSessions', 'unbounded'], fs: healthyFs() })).byName.get(
        'max sessions',
      )?.status,
    ).toBe('warn');
    expect(
      (await doctorJson({ argv: ['--maxSessions', '15'], fs: healthyFs() })).byName.get(
        'max sessions',
      )?.status,
    ).toBe('warn');
    expect(
      (await doctorJson({ argv: ['--maxSessions', '4'], fs: healthyFs() })).byName.get(
        'max sessions',
      )?.status,
    ).toBe('ok');
  });

  it('authTokens in a world-readable config file is a warning', async () => {
    const fs = healthyFs();
    fs.put('/work/browserhive.config.json', JSON.stringify({ authTokens: [TOKEN] }), 0o644);
    const { byName } = await doctorJson({ argv: [], fs });
    expect(byName.get('secrets')?.status).toBe('warn');
    expect(byName.get('secrets')?.detail).toContain('chmod 600 /work/browserhive.config.json');
    const tight = healthyFs();
    tight.put('/work/browserhive.config.json', JSON.stringify({ authTokens: [TOKEN] }), 0o600);
    expect((await doctorJson({ argv: [], fs: tight })).byName.get('secrets')?.status).toBe('ok');
  });

  it('an invalid configuration is a failed check, not a usage error', async () => {
    const { byName, run } = await doctorJson({
      argv: [],
      env: { BROWSERHIVE_PORT: 'abc' },
      fs: healthyFs(),
    });
    expect(run.code).toBe(1);
    expect(byName.get('config')?.status).toBe('fail');
    expect(byName.get('config')?.detail).toContain("invalid value for BROWSERHIVE_PORT: 'abc'");
    expect(byName.has('port')).toBe(false);
  });

  it('a missing data dir and database are warnings', async () => {
    const { byName, run } = await doctorJson({ argv: [] });
    expect(byName.get('data dir')?.status).toBe('warn');
    expect(byName.get('database')?.status).toBe('warn');
    expect(run.code).toBe(2);
  });
});

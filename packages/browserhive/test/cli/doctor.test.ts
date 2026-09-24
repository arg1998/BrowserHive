/** @module test/cli/doctor — `browserhive doctor`: every check with injected probes, exit 0/1/2, `--json` shape */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  cliHarness,
  DATA_DIR,
  detected,
  MemoryFs,
  probeState,
  sandboxEnvironment,
  storageState,
} from './helpers.ts';

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
      'chrome',
      'edge',
      'default channel',
      'managed policies',
      'sandbox (chromium)',
      'user',
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
    expect(run.stdout).toContain('18 passed, 0 warnings, 0 failed');
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

describe('doctor: browsers and the sandbox', () => {
  const ubuntu = sandboxEnvironment({
    distro: 'Ubuntu 24.04.1 LTS',
    apparmorRestrictsUserns: true,
  });
  const unavailable = { state: 'unavailable', reason: 'No usable sandbox!' } as const;
  const works = { state: 'works', version: '154.0.8037.57' } as const;

  it('defaultChannel=chrome with Chrome missing is a failure (no longer a false ✓)', async () => {
    const { byName, run } = await doctorJson({
      argv: ['--defaultChannel', 'chrome'],
      fs: healthyFs(),
    });
    expect(byName.get('default channel')).toEqual({
      check: 'default channel',
      status: 'fail',
      detail:
        "defaultChannel=chrome but Google Chrome is not installed; 'browserhive init --installChrome', or set defaultChannel=chromium",
    });
    expect(run.code).toBe(1);
  });

  it('an installed Chrome is listed with version and path, and the configured channel passes', async () => {
    const { byName } = await doctorJson({
      argv: ['--defaultChannel', 'chrome'],
      fs: healthyFs(),
      probes: probeState({
        browsers: [detected('chromium'), detected('chrome', { installed: true }), detected('edge')],
        sandbox: { chromium: works, chrome: works },
      }),
    });
    expect(byName.get('chrome')?.detail).toBe(
      'Google Chrome 154.0.8037.57 · /opt/google/chrome/chrome',
    );
    expect(byName.get('default channel')).toMatchObject({
      status: 'ok',
      detail: 'chrome · Google Chrome 154.0.8037.57',
    });
    expect(byName.get('version drift')?.status).toBe('ok');
    expect(byName.get('sandbox (chrome)')?.status).toBe('ok');
  });

  it('version drift warns only for the channel in use', async () => {
    const ahead = detected('chrome', { installed: true, version: '156.0.1.2' });
    const inUse = await doctorJson({
      argv: ['--defaultChannel', 'chrome'],
      fs: healthyFs(),
      probes: probeState({ browsers: [detected('chromium'), ahead, detected('edge')] }),
    });
    expect(inUse.byName.get('version drift')?.status).toBe('warn');
    expect(inUse.byName.get('version drift')?.detail).toContain(
      'Google Chrome 156 is more than one major version ahead of the Chromium 153',
    );
    const notInUse = await doctorJson({
      argv: [],
      fs: healthyFs(),
      probes: probeState({ browsers: [detected('chromium'), ahead, detected('edge')] }),
    });
    expect(notInUse.byName.get('version drift')).toMatchObject({ status: 'ok' });
    expect(notInUse.byName.get('version drift')?.detail).toContain('(not in use)');
  });

  it('a managed policy blocking automation fails for the configured channel, warns otherwise', async () => {
    const managed = detected('chrome', {
      installed: true,
      policies: {
        location: '/etc/opt/chrome/policies/managed',
        names: ['HomepageLocation', 'RemoteDebuggingAllowed'],
        blocking: ['RemoteDebuggingAllowed=false'],
      },
    });
    const probes = probeState({ browsers: [detected('chromium'), managed, detected('edge')] });
    const configured = await doctorJson({
      argv: ['--defaultChannel', 'chrome'],
      fs: healthyFs(),
      probes,
    });
    expect(configured.byName.get('managed policies')).toMatchObject({
      status: 'fail',
      detail:
        'Google Chrome: RemoteDebuggingAllowed=false blocks automation (/etc/opt/chrome/policies/managed)',
    });
    const other = await doctorJson({ argv: [], fs: healthyFs(), probes });
    expect(other.byName.get('managed policies')?.status).toBe('warn');
  });

  it('sandbox rows: probed once per installed channel; the verdict is judged by the mode', async () => {
    const probes = probeState({
      browsers: [detected('chromium'), detected('chrome', { installed: true }), detected('edge')],
      sandbox: { chromium: unavailable, chrome: works },
      environment: ubuntu,
      apparmorCovered: false,
    });
    const auto = await doctorJson({ argv: [], fs: healthyFs(), probes });
    expect(probes.probed).toEqual(['chromium', 'chrome']);
    expect(auto.run.code).toBe(0);
    expect(auto.byName.get('sandbox (chromium)')).toMatchObject({
      status: 'ok',
      detail:
        'cannot run sandboxed here, falls back to no sandbox (sandbox=auto): No usable sandbox!',
    });
    expect(auto.byName.get('sandbox (chrome)')).toMatchObject({
      status: 'ok',
      detail: 'runs sandboxed (sandbox=auto)',
    });
    const off = await doctorJson({ argv: ['--sandbox', 'off'], fs: healthyFs(), probes });
    expect(off.byName.get('sandbox (chromium)')).toMatchObject({
      status: 'ok',
      detail: 'sandbox=off; cannot run sandboxed here: No usable sandbox!',
    });
    const on = await doctorJson({ argv: ['--sandbox', 'on'], fs: healthyFs(), probes });
    expect(on.byName.get('sandbox (chromium)')?.status).toBe('fail');
    expect(on.run.code).toBe(1);
    const onChrome = await doctorJson({
      argv: ['--sandbox', 'on', '--defaultChannel', 'chrome'],
      fs: healthyFs(),
      probes,
    });
    expect(onChrome.byName.get('sandbox (chromium)')?.status).toBe('warn');
    expect(onChrome.byName.get('sandbox (chrome)')?.status).toBe('ok');
  });

  it('text mode prints the guidance for the configured channel: working browser first, AppArmor next', async () => {
    const run = await cliHarness({
      argv: ['doctor'],
      fs: healthyFs(),
      probes: probeState({
        browsers: [detected('chromium'), detected('chrome', { installed: true }), detected('edge')],
        sandbox: { chromium: unavailable, chrome: works },
        environment: ubuntu,
        apparmorCovered: false,
      }),
    });
    const text = run.stdout;
    expect(text).toContain(
      "The configured browser (chromium) cannot run with Chromium's sandbox on this host.",
    );
    expect(text).toContain("  reason    No usable sandbox! (Chrome's own message)");
    expect(text).toContain(
      'cause     Ubuntu 24.04.1 LTS restricts unprivileged user namespaces to programs with an',
    );
    const first = text.indexOf('1. Use the installed Google Chrome.');
    const second = text.indexOf('2. Keep the bundled browser and give it an AppArmor profile');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(text).toContain('browserhive --sandbox on --defaultChannel chrome');
    expect(text).toContain(
      'browserhive doctor --printApparmorProfile | sudo tee /etc/apparmor.d/browserhive-chromium',
    );
  });

  it('as root the sandbox is not probed and the rows explain why', async () => {
    const probes = probeState({ environment: sandboxEnvironment({ root: true, container: true }) });
    const { byName } = await doctorJson({ argv: [], fs: healthyFs(), probes });
    expect(probes.probed).toEqual([]);
    expect(byName.get('sandbox')?.detail).toContain('running as root');
    expect(byName.get('user')?.detail).toContain('running as root in a container');
  });

  it('--printApparmorProfile prints the profile for the bundled browser and exits 0', async () => {
    const run = await cliHarness({ argv: ['doctor', '--printApparmorProfile'], fs: healthyFs() });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(
      'profile browserhive-chromium /cache/chromium-1243/chrome flags=(unconfined) {',
    );
    expect(run.stdout).toContain('  userns,');
  });

  it('--printApparmorProfile refuses when the configured browser is not installed', async () => {
    const run = await cliHarness({
      argv: ['doctor', '--printApparmorProfile', '--defaultChannel', 'edge'],
      fs: healthyFs(),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("no Microsoft Edge is installed for channel 'edge'");
  });
});

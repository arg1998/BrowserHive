/** @module scripts/smoke-global-install — installs the packed tarball globally with npm and with Bun, into a throwaway prefix, and checks both commands, `browserhive` and its `bh` shorthand (spec 06 §6 "global-install") */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { z } from 'zod';

const USAGE = 'usage: smoke-global-install.ts <tarball> [--dir <empty work dir>] [--keep]';
const args = process.argv.slice(2);
const tarballArg = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--dir');
if (tarballArg === undefined) {
  console.error(USAGE);
  process.exit(64);
}
const tarball = resolve(tarballArg);
const dirFlag = args.indexOf('--dir');
const dirArg = dirFlag === -1 ? undefined : args[dirFlag + 1];
const keep = args.includes('--keep');
const windows = process.platform === 'win32';

// Everything lands under one throwaway directory: never the machine's real global prefix.
const root =
  dirArg === undefined ? mkdtempSync(join(tmpdir(), 'bh-global-')) : resolve(dirArg, 'bh-global');
mkdirSync(root, { recursive: true });

function fail(message: string): never {
  console.error(`smoke-global-install: ${message}`);
  console.error(`smoke-global-install: work dir kept at ${root}`);
  process.exit(1);
}

/** The environment with `binDir` first on PATH (whatever the variable is called on this OS). */
function envWith(binDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = `${binDir}${delimiter}${env[key] ?? ''}`;
  return env;
}

/** Runs a command by name through the OS shell, the way a user types it. */
function shell(command: string, env: NodeJS.ProcessEnv, cwd = root): SpawnSyncReturns<string> {
  return spawnSync(command, { cwd, env, encoding: 'utf8', shell: true, timeout: 180_000 });
}

function output(r: SpawnSyncReturns<string>): string {
  return `exit ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`;
}

const DoctorRows = z.array(z.object({ check: z.string(), status: z.string(), detail: z.string() }));

function checkInstall(label: string, binDir: string, extraEnv: Record<string, string>): void {
  const env = envWith(binDir, extraEnv);
  const full = shell('browserhive --version', env);
  const short = shell('bh --version', env);
  if (full.status !== 0 || !/^browserhive \d+\.\d+\.\d+/.test(full.stdout))
    fail(`${label}: browserhive --version\n${output(full)}`);
  if (short.status !== 0 || short.stdout !== full.stdout)
    fail(`${label}: bh --version differs from browserhive --version\n${output(short)}`);
  console.log(`smoke-global-install: ${label}: browserhive --version → ${full.stdout.trim()}`);
  console.log(`smoke-global-install: ${label}: bh --version          → ${short.stdout.trim()}`);

  if (windows) {
    // PowerShell runs the `.ps1` shims (npm) or the `.exe` launcher (Bun) for both names.
    for (const name of ['browserhive', 'bh']) {
      const ps = spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${name} --version`],
        { cwd: root, env, encoding: 'utf8', timeout: 180_000 },
      );
      if (ps.status !== 0 || ps.stdout !== full.stdout)
        fail(`${label}: PowerShell ${name} --version\n${output(ps)}`);
    }
    console.log(`smoke-global-install: ${label}: PowerShell runs both names`);
  }

  // The doctor row must recognise this install's `bh` as BrowserHive's on every OS.
  const dataDir = join(root, `data-${label}`);
  const doctor = shell(`browserhive doctor --json --dataDir "${dataDir}"`, env);
  let rows: z.infer<typeof DoctorRows>;
  try {
    rows = DoctorRows.parse(JSON.parse(doctor.stdout));
  } catch (err) {
    fail(
      `${label}: doctor --json is not the expected JSON (${err instanceof Error ? err.message : 'parse error'})\n${output(doctor)}`,
    );
  }
  const row = rows.find((candidate) => candidate.check === 'bh');
  if (
    row === undefined ||
    row.status !== 'ok' ||
    !row.detail.startsWith('shorthand for browserhive')
  )
    fail(`${label}: doctor bh row: ${JSON.stringify(row)}`);
  console.log(`smoke-global-install: ${label}: doctor bh → ${row.status} · ${row.detail}`);
}

try {
  if (!existsSync(tarball)) fail(`no tarball at ${tarball}`);

  // npm: `--prefix` puts bins in <prefix>/bin on POSIX and in <prefix> itself on Windows.
  const npmPrefix = join(root, 'npm');
  const npm = shell(`npm install -g --no-audit --no-fund --prefix "${npmPrefix}" "${tarball}"`, {
    ...process.env,
    npm_config_prefix: npmPrefix,
  });
  if (npm.status !== 0) fail(`npm install -g failed\n${output(npm)}`);
  const npmBin = windows ? npmPrefix : join(npmPrefix, 'bin');
  const npmShims = windows
    ? ['bh.cmd', 'bh.ps1', 'browserhive.cmd', 'browserhive.ps1']
    : ['bh', 'browserhive'];
  for (const shim of npmShims) {
    if (!existsSync(join(npmBin, shim))) fail(`npm did not create ${join(npmBin, shim)}`);
  }
  console.log(`smoke-global-install: npm created ${npmShims.join(', ')} in ${npmBin}`);
  checkInstall('npm', npmBin, { npm_config_prefix: npmPrefix });

  // Bun: BUN_INSTALL moves the global dir and its bin dir.
  const bunHome = join(root, 'bun');
  const bunEnv = { BUN_INSTALL: bunHome };
  const bun = shell(`bun add -g "${tarball}"`, { ...process.env, ...bunEnv });
  if (bun.status !== 0) fail(`bun add -g failed\n${output(bun)}`);
  const bunBin = join(bunHome, 'bin');
  const bunShims = windows
    ? ['bh.exe', 'bh.bunx', 'browserhive.exe', 'browserhive.bunx']
    : ['bh', 'browserhive'];
  for (const shim of bunShims) {
    if (!existsSync(join(bunBin, shim))) fail(`bun did not create ${join(bunBin, shim)}`);
  }
  console.log(`smoke-global-install: bun created ${bunShims.join(', ')} in ${bunBin}`);
  checkInstall('bun', bunBin, bunEnv);

  console.log('smoke-global-install: ok');
} finally {
  if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

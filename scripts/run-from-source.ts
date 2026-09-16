/**
 * @module scripts/run-from-source — `bun run browserhive [flags]`: runs the CLI from a source checkout.
 *
 * Bun runs the server's TypeScript directly; the dashboard is a Vite app. Two modes:
 * - **Hot reload (default when serving with `--admin`):** the daemon starts as usual, and a Vite dev
 *   server starts next to it on `--port` + 10000, proxying `/api`, `/mcp`, `/health`, `/trace-viewer`
 *   and the WebSocket to the daemon (`vite.config.ts`). Open the printed Vite URL: edits hot-reload.
 *   The daemon's own port keeps serving the last built bundle, and agents keep using its `/mcp`.
 * - **Bundle (`BHDEV_DASHBOARD=dist`, and every other command):** rebuilds `packages/dashboard/dist`
 *   when any input is newer than the last build, then runs the CLI, which serves the bundle.
 *
 * Dev variables use the `BHDEV_` prefix because the CLI rejects unknown `BROWSERHIVE_*` variables.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const dashboard = join(root, 'packages', 'dashboard');
const builtIndex = join(dashboard, 'dist', 'index.html');
const args = process.argv.slice(2);

/** Everything the dashboard bundle is built from (its own sources and the contracts it imports). */
const INPUTS = [
  join(dashboard, 'src'),
  join(dashboard, 'public'),
  join(dashboard, 'index.html'),
  join(dashboard, 'vite.config.ts'),
  join(dashboard, 'package.json'),
  join(root, 'packages', 'contracts', 'src'),
];

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

function buildDashboardIfStale(): void {
  const builtAt = existsSync(builtIndex) ? statSync(builtIndex).mtimeMs : 0;
  if (!INPUTS.some((input) => newestMtime(input) > builtAt)) return;
  console.error('browserhive(dev): dashboard sources changed, rebuilding packages/dashboard/dist…');
  const build = spawnSync('bun', ['run', '--filter', '@browserhive/dashboard', 'build'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (build.status !== 0) {
    console.error('browserhive(dev): dashboard build failed (see above); not starting.');
    process.exit(build.status ?? 1);
  }
}

/** Value of `--name N` / `--name=N`, if given. */
function flag(name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
    if (arg === `--${name}`) return args[i + 1];
  }
  return undefined;
}

/** True for the default `serve` command with the dashboard enabled. */
function servesDashboard(): boolean {
  // Subcommands come first (`browserhive doctor …`); later positionals are flag values.
  const first = args[0];
  if (first !== undefined && !first.startsWith('-') && first !== 'serve') return false;
  return args.some((arg) => arg === '--admin' || arg === '--admin=true');
}

const hotReload = process.env['BHDEV_DASHBOARD'] !== 'dist' && servesDashboard();
if (!hotReload) buildDashboardIfStale();

const cli = spawn('bun', [join(root, 'packages', 'browserhive', 'src', 'bin.ts'), ...args], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
let vite: ChildProcess | undefined;

if (hotReload) {
  const daemonPort = Number(flag('port') ?? 9876);
  const bind = flag('host');
  const daemonHost = bind === undefined || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
  const daemonUrl = `http://${daemonHost.includes(':') ? `[${daemonHost}]` : daemonHost}:${daemonPort}`;
  // A fixed port per daemon, so the Vite URL survives restarts and open tabs reconnect by themselves.
  const vitePort = daemonPort + 10_000 <= 65_535 ? daemonPort + 10_000 : daemonPort - 10_000;
  const viteUrl = `http://127.0.0.1:${vitePort}`;
  const started = spawn(
    'bun',
    ['x', 'vite', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
    {
      cwd: dashboard,
      env: { ...process.env, BHDEV_DAEMON_URL: daemonUrl },
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  vite = started;
  started.on('exit', (code) => {
    if (cli.exitCode === null) {
      console.error(
        `browserhive(dev): Vite exited (${code}); is port ${vitePort} in use? Hot reload is off until restart.`,
      );
    }
  });
  // Printed once both answer, so the line lands after the daemon's startup banner.
  void (async () => {
    for (let attempt = 0; attempt < 1200 && started.exitCode === null; attempt++) {
      try {
        await fetch(`${viteUrl}/@vite/client`);
        await fetch(`${daemonUrl}/health`);
        await Bun.sleep(300);
        console.error(
          `\n  browserhive(dev): Dashboard with hot reload → ${viteUrl}/\n` +
            `  (${daemonUrl}/ serves the last built bundle; agents keep using ${daemonUrl}/mcp)\n`,
        );
        return;
      } catch {
        await Bun.sleep(100);
      }
    }
  })();
}

// Ctrl+C reaches both children through the process group; forward SIGTERM and wait for shutdown.
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => {
  cli.kill('SIGTERM');
  vite?.kill('SIGTERM');
});
cli.on('exit', (code, signal) => {
  vite?.kill('SIGTERM');
  process.exit(code ?? (signal === null ? 0 : 1));
});

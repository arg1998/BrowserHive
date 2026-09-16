/** @module scripts/dev — runs the server (watch mode, pretty logs) and the dashboard Vite dev server together. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const extra = process.argv.slice(2);

const server = spawn(
  'bun',
  [
    '--watch',
    'packages/browserhive/src/bin.ts',
    'serve',
    '--logFormat',
    'pretty',
    '--logLevel',
    'debug',
    '--admin',
    ...extra,
  ],
  { cwd: root, stdio: 'inherit' },
);
const dashboard = spawn('bun', ['run', '--filter', '@browserhive/dashboard', 'dev'], {
  cwd: root,
  stdio: 'inherit',
});

const stop = (): void => {
  server.kill('SIGTERM');
  dashboard.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => {
  dashboard.kill('SIGTERM');
  process.exit(code ?? 0);
});
dashboard.on('exit', (code) => {
  if (code !== null && code !== 0) {
    server.kill('SIGTERM');
    process.exit(code);
  }
});

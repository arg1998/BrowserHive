/** @module scripts/init-browsers — installs Chromium for Playwright and (fail-open) Patchright for local development. */
import { spawnSync } from 'node:child_process';

function run(cmd: string, args: string[]): number {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  return res.status ?? 1;
}

const pw = run('bunx', ['playwright', 'install', 'chromium']);
if (pw !== 0) {
  console.error('init-browsers: playwright install chromium failed');
  process.exit(pw);
}
const pr = run('bunx', ['patchright', 'install', 'chromium']);
if (pr !== 0) {
  console.warn(
    'init-browsers: patchright install failed; stealth sessions will fall back to stock Playwright',
  );
}
console.log('init-browsers: done');

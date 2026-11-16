/** @module scripts/init-browsers — installs Patchright's Chromium (the only driver, D-65) for local development; the dashboard e2e runner (`@playwright/test`, same pinned version) launches the same build from the same cache. */
import { spawnSync } from 'node:child_process';

function run(cmd: string, args: string[]): number {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  return res.status ?? 1;
}

const status = run('bunx', ['patchright', 'install', 'chromium']);
if (status !== 0) {
  console.error('init-browsers: patchright install chromium failed');
  process.exit(status);
}
console.log('init-browsers: done');

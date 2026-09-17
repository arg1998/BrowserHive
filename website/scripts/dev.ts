/** @module website/scripts/dev — keeps docs in sync with ../docs while running the Astro dev server. */
import { spawn } from 'node:child_process';
import { syncDocs } from './sync-docs.ts';

syncDocs();
const children = [
  spawn('bun', ['scripts/sync-docs.ts', '--watch'], { stdio: 'inherit' }),
  spawn('bunx', ['--bun', 'astro', 'dev', ...process.argv.slice(2)], { stdio: 'inherit' }),
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => code && stop());

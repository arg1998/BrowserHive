/** @module scripts/coverage-ratchet — raises the coverage threshold in bunfig.toml by one point when the suite exceeds it. */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const bunfig = join(root, 'bunfig.toml');
const text = readFileSync(bunfig, 'utf8');
const match = /coverageThreshold\s*=\s*([\d.]+)/.exec(text);
const current = match ? Number(match[1]) : 0;
const res = spawnSync(
  'bun',
  ['run', 'test:server', '--', '--coverage', '--coverage-reporter=text'],
  {
    cwd: root,
    encoding: 'utf8',
  },
);
const all = /All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(res.stdout + res.stderr);
if (!all) {
  console.error('coverage-ratchet: could not read coverage summary');
  process.exit(1);
}
const lines = Number(all[2]);
const next = Math.min(Math.floor(lines) - 1, current + 1);
if (next > current) {
  const updated = match
    ? text.replace(/coverageThreshold\s*=\s*[\d.]+/, `coverageThreshold = ${next / 100}`)
    : `${text}\ncoverageThreshold = ${next / 100}\n`;
  writeFileSync(bunfig, updated);
  console.log(`coverage-ratchet: ${current} -> ${next}`);
} else {
  console.log(`coverage-ratchet: unchanged (${current}, measured ${lines})`);
}

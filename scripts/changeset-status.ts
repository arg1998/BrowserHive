/** @module scripts/changeset-status — fails a PR that changes package sources without a changeset unless labeled no-changeset. */
import { execSync } from 'node:child_process';

const labels = (process.env['PR_LABELS'] ?? '').split(',').map((s) => s.trim());
if (labels.includes('no-changeset')) {
  console.log('changeset-status: no-changeset label present');
  process.exit(0);
}
const base = process.env['GITHUB_BASE_REF'] ?? 'main';
execSync(`git fetch origin ${base} --depth=1`, { stdio: 'ignore' });
const changed = execSync(`git diff --name-only origin/${base}...HEAD`, { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const touchesSrc = changed.some((f) =>
  /^packages\/(contracts|core|dashboard|browserhive)\/src\//.test(f),
);
const hasChangeset = changed.some(
  (f) => /^\.changeset\/.+\.md$/.test(f) && !f.endsWith('README.md'),
);
if (touchesSrc && !hasChangeset) {
  console.error(
    'changeset-status: package sources changed without a changeset (run `bunx changeset` or add the no-changeset label)',
  );
  process.exit(1);
}
console.log('changeset-status: ok');

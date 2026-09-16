/** @module browserhive/scripts/bundle-dashboard — copies the built dashboard into dist/dashboard; fails when it is missing (spec 06 §4). */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const here = join(import.meta.dir, '..');
const source = join(here, '../dashboard/dist');
const target = join(here, 'dist/dashboard');
if (!existsSync(join(source, 'index.html'))) {
  console.error(
    'bundle-dashboard: packages/dashboard/dist/index.html is missing; run `bun run --filter @browserhive/dashboard build` first',
  );
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`bundle-dashboard: copied ${source} -> ${target}`);

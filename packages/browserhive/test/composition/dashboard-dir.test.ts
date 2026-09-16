/** @module test/composition/dashboard-dir — the dashboard resolver picks a built bundle, never the Vite source page */
import { describe, expect, it } from 'bun:test';
import { resolveDashboardDir } from '../../src/composition/dashboard-dir.ts';

const fromSource = 'file:///repo/packages/browserhive/src/composition/dashboard-dir.ts';
const fromPackage = 'file:///app/node_modules/browserhive/dist/composition-x.js';

function fs(paths: readonly string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

describe('resolveDashboardDir', () => {
  it('from source, prefers packages/dashboard/dist over the source index.html (regression)', () => {
    const exists = fs([
      '/repo/packages/dashboard/index.html',
      '/repo/packages/dashboard/dist/index.html',
      '/repo/packages/dashboard/dist/assets',
    ]);
    expect(resolveDashboardDir(fromSource, exists)).toBe('/repo/packages/dashboard/dist');
  });

  it('from source without a build, returns undefined instead of the source page', () => {
    const exists = fs(['/repo/packages/dashboard/index.html']);
    expect(resolveDashboardDir(fromSource, exists)).toBeUndefined();
  });

  it('in the published package, uses dist/dashboard', () => {
    const exists = fs([
      '/app/node_modules/browserhive/dist/dashboard/index.html',
      '/app/node_modules/browserhive/dist/dashboard/assets',
    ]);
    expect(resolveDashboardDir(fromPackage, exists)).toBe(
      '/app/node_modules/browserhive/dist/dashboard',
    );
  });
});

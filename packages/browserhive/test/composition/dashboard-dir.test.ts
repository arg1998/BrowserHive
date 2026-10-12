/** @module test/composition/dashboard-dir — the dashboard resolver picks a built bundle, never the Vite source page */
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDashboardDir } from '../../src/composition/dashboard-dir.ts';

/** A host-absolute path from a POSIX one (`/repo/x` → `C:\repo\x` on Windows, unchanged elsewhere). */
const p = (posix: string): string => resolve(posix);
/** The `file:` URL of {@link p} (a drive-less `file:///repo/…` URL is not absolute on Windows). */
const url = (posix: string): string => pathToFileURL(p(posix)).href;

const fromSource = url('/repo/packages/browserhive/src/composition/dashboard-dir.ts');
const fromPackage = url('/app/node_modules/browserhive/dist/composition-x.js');

function fs(paths: readonly string[]): (path: string) => boolean {
  const set = new Set(paths.map(p));
  return (path) => set.has(path);
}

describe('resolveDashboardDir', () => {
  it('from source, prefers packages/dashboard/dist over the source index.html (regression)', () => {
    const exists = fs([
      '/repo/packages/dashboard/index.html',
      '/repo/packages/dashboard/dist/index.html',
      '/repo/packages/dashboard/dist/assets',
    ]);
    expect(resolveDashboardDir(fromSource, exists)).toBe(p('/repo/packages/dashboard/dist'));
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
      p('/app/node_modules/browserhive/dist/dashboard'),
    );
  });

  it('resolves from the real module URL of this host (Windows drive letters included)', () => {
    const exists = fs(['/srv/bh/dist/dashboard/index.html', '/srv/bh/dist/dashboard/assets']);
    expect(resolveDashboardDir(url('/srv/bh/dist/index.js'), exists)).toBe(
      p('/srv/bh/dist/dashboard'),
    );
  });
});

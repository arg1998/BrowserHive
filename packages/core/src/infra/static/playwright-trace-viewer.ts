/** @module infra/static/playwright-trace-viewer — locates `playwright-core/lib/vite/traceViewer` at runtime (hoisted and strict stores). */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { TraceViewerAssets } from '../../ports/static-assets.ts';
import { createDirectoryAssets } from './directory-assets.ts';

/** The viewer directory, or `undefined` when Playwright is not installed. */
export function resolveTraceViewerDir(fromUrl: string = import.meta.url): string | undefined {
  const req = createRequire(fromUrl);
  const strategies: (() => string)[] = [
    () => dirname(req.resolve('playwright-core/package.json')),
    () =>
      dirname(
        createRequire(req.resolve('playwright/package.json')).resolve(
          'playwright-core/package.json',
        ),
      ),
  ];
  for (const locate of strategies) {
    try {
      const dir = join(locate(), 'lib', 'vite', 'traceViewer');
      if (existsSync(join(dir, 'index.html'))) return dir;
    } catch {
      // Not resolvable through this strategy; try the next one.
    }
  }
  return undefined;
}

/** The trace viewer assets (unavailable provider when the bundle is missing). */
export function createTraceViewerAssets(
  dir: string | undefined = resolveTraceViewerDir(),
): TraceViewerAssets {
  return createDirectoryAssets(dir);
}

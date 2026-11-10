/** @module composition/dashboard-dir — locates the built dashboard SPA: `dist/dashboard` next to the bundled package, or `packages/dashboard/dist` when running from source. */
/**
 * Returns the directory holding the dashboard's `index.html`, or `undefined` when no build exists
 * (the HTTP layer then serves 404 for SPA routes; `bun run --filter @browserhive/dashboard build`).
 */
export declare function resolveDashboardDir(
  fromUrl?: string,
  exists?: (path: string) => boolean,
): string | undefined;
//# sourceMappingURL=dashboard-dir.d.ts.map

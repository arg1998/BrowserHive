/** @module dashboard/vite.config — Vite 8 build: React, TanStack file routes, Tailwind v4, dev proxy to the daemon (spec 04 §2) */
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The daemon the dev server proxies to (spec 05 §13); `BHDEV_DAEMON_URL` points it at another instance.
 * (Dev variables use `BHDEV_`: the CLI rejects unknown `BROWSERHIVE_*` variables.)
 * `changeOrigin: false` keeps the Origin gate happy.
 */
const DAEMON_URL = process.env['BHDEV_DAEMON_URL'] ?? 'http://127.0.0.1:9876';
/** Paths forwarded to the daemon in development; `/api` covers `/api/v1/ws` (`ws: true`). */
const PROXIED_PATHS = ['/api', '/mcp', '/health', '/trace-viewer'] as const;

const srcDir = new URL('./src', import.meta.url).pathname;

export default defineConfig(({ mode }) => ({
  base: '/',
  optimizeDeps: {
    // Scan every source file at startup. Routes are code-split, so the default scan (index.html only)
    // would find their dependencies lazily and re-bundle mid-session, reloading open tabs.
    entries: ['index.html', 'src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}'],
  },
  resolve: { alias: { '@': srcDir } },
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      quoteStyle: 'single',
      semicolons: true,
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: Object.fromEntries(
      PROXIED_PATHS.map((path) => [path, { target: DAEMON_URL, changeOrigin: false, ws: true }]),
    ),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Sourcemaps never ship in the published package (D-11); only non-production builds keep them.
    sourcemap: mode !== 'production',
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [
            // Only the chart libraries themselves: pulling their dependencies (React) into `charts`
            // would make every page chunk import it eagerly.
            {
              name: 'charts',
              test: /node_modules[\\/](recharts|d3-[a-z-]+|victory-vendor)/,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
}));

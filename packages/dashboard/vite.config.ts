/** @module dashboard/vite.config — Vite 8 build: React, TanStack file routes, Tailwind v4, the offline page and service worker (04 §18.5.6), dev proxy to the daemon (spec 04 §2) */
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { offlineSwPlugin } from './scripts/offline-sw-plugin.ts';
import { PROXIED_PATHS } from './src/dev-proxy.ts';

/**
 * The daemon the dev server proxies to (spec 05 §13); `BHDEV_DAEMON_URL` points it at another instance.
 * (Dev variables use `BHDEV_`: the CLI rejects unknown `BROWSERHIVE_*` variables.)
 * `changeOrigin: false` keeps the Origin gate happy.
 */
const DAEMON_URL = process.env['BHDEV_DAEMON_URL'] ?? 'http://127.0.0.1:9876';

// A file-system path on every OS (`URL.pathname` would be `/C:/…` on Windows).
const packageDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = new URL('./src', import.meta.url).pathname;

/**
 * `BHDEV_SW_KILL_SWITCH=1` builds the kill-switch worker as `sw.js` instead of the offline worker:
 * the release that removes a misbehaving worker from every browser (04 §18.5.7).
 */
const WORKER = process.env['BHDEV_SW_KILL_SWITCH'] === '1' ? 'kill-switch' : 'offline';

export default defineConfig(({ mode }) => ({
  base: '/',
  optimizeDeps: {
    // Scan every source file at startup. Routes are code-split, so the default scan (index.html only)
    // would find their dependencies lazily and re-bundle mid-session, reloading open tabs.
    // `offline.html` is served as a plain page by the dev server, for design work (no worker in dev).
    entries: ['index.html', 'offline.html', 'src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}'],
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
    offlineSwPlugin({ root: packageDir, worker: WORKER }),
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
    // The main build's only entry stays index.html: the offline page is built on its own by the plugin.
    rolldownOptions: {
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

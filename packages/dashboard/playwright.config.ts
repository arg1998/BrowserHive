/** @module dashboard/playwright.config — e2e runner; expects a running daemon at `BROWSERHIVE_E2E_URL` (spec 09) */
import { defineConfig, devices } from '@playwright/test';

/** Set by CI (`bun run test:e2e`) to the base URL of a daemon started with a fixture data dir. */
const baseURL = process.env['BROWSERHIVE_E2E_URL'];

/** The installable-app spec runs only in its own project. */
const PWA_SPEC = '**/pwa.e2e.ts';

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  // One operator account: projects share it, so they must not rotate its password concurrently.
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  retries: process.env['CI'] !== undefined ? 1 : 0,
  reporter: process.env['CI'] !== undefined ? 'github' : 'list',
  use: {
    ...(baseURL !== undefined && { baseURL }),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // The offline service worker (D-59) must never touch the existing journeys.
    {
      name: 'desktop',
      testIgnore: PWA_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        serviceWorkers: 'block',
      },
    },
    {
      name: 'phone',
      testIgnore: PWA_SPEC,
      use: { ...devices['Pixel 7'], serviceWorkers: 'block' },
    },
    // Installable app (04 §18.12, 09 §3.5): the worker is allowed here, and only here.
    {
      name: 'pwa',
      testMatch: PWA_SPEC,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        serviceWorkers: 'allow',
      },
    },
  ],
});

/** @module dashboard/playwright.config — e2e runner; expects a running daemon at `BROWSERHIVE_E2E_URL` (spec 09) */
import { defineConfig, devices } from '@playwright/test';

/** Set by CI (`bun run test:e2e`) to the base URL of a daemon started with a fixture data dir. */
const baseURL = process.env['BROWSERHIVE_E2E_URL'];

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
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});

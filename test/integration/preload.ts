/** @module test/integration/preload — preload for real-Chromium suites: UTC, no implicit env. The per-test and per-hook limit is `--timeout` from `scripts/test-integration.ts` (a preload's `setDefaultTimeout` only reaches the first file). */
process.env['TZ'] = 'UTC';
process.env['BROWSERHIVE_INTEGRATION'] = '1';

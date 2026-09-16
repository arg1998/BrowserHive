/** @module test/integration/preload — preload for real-Chromium suites: UTC, generous timeouts, no implicit env. */
process.env['TZ'] = 'UTC';
process.env['BROWSERHIVE_INTEGRATION'] = '1';

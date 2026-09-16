/** @module test/integration/preload — core real-Chromium suites: UTC clock, single worker hint; fails loudly when no browser is installed. */
process.env['TZ'] = 'UTC';
process.env['BROWSERHIVE_INTEGRATION'] = '1';

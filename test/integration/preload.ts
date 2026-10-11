/** @module test/integration/preload — preload for real-Chromium suites: UTC, generous timeouts, no implicit env. */
import { setDefaultTimeout } from 'bun:test';

process.env['TZ'] = 'UTC';
process.env['BROWSERHIVE_INTEGRATION'] = '1';

/**
 * Per-test and per-hook limit for the real-browser suites. Bun's own default is 5 s, which a test
 * that launches Chromium and runs a fixture server per test exceeds on slower runners (macOS and
 * Windows CI are 2–3× slower than Ubuntu, issue #23). On a timeout Bun also kills the processes the
 * test spawned, so one slow hook cascades into `BROWSER_CRASHED` and `Target closed` failures in the
 * tests after it. Tests that need longer still pass their own limit.
 */
export const INTEGRATION_TIMEOUT_MS = 30_000;

/** `BHDEV_TEST_TIMEOUT_MS` overrides the limit (a slow local machine, a debugger session). */
export function integrationTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['BHDEV_TEST_TIMEOUT_MS'];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : INTEGRATION_TIMEOUT_MS;
}

setDefaultTimeout(integrationTimeoutMs(process.env));

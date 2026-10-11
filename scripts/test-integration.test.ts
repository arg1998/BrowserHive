/** @module scripts/test-integration.test — `bun run test:integration`: the 30 s `--timeout` (a preload's `setDefaultTimeout` only reaches the first file), `BHDEV_TEST_TIMEOUT_MS`, and pass-through arguments. */
import { describe, expect, it } from 'bun:test';
import {
  INTEGRATION_SUITES,
  INTEGRATION_TIMEOUT_MS,
  integrationArgs,
  integrationTimeoutMs,
} from './test-integration.ts';

describe('integration timeout', () => {
  it('defaults to 30 s, well above Bun’s 5 s', () => {
    expect(INTEGRATION_TIMEOUT_MS).toBe(30_000);
    expect(integrationTimeoutMs({})).toBe(30_000);
  });

  it('BHDEV_TEST_TIMEOUT_MS overrides it with a positive integer', () => {
    expect(integrationTimeoutMs({ BHDEV_TEST_TIMEOUT_MS: '120000' })).toBe(120_000);
  });

  it('ignores values that are not a positive integer', () => {
    for (const raw of ['', 'soon', '0', '-5', '1.5', 'NaN']) {
      expect(integrationTimeoutMs({ BHDEV_TEST_TIMEOUT_MS: raw })).toBe(30_000);
    }
  });
});

describe('integrationArgs', () => {
  it('passes the limit as --timeout to every file, serially, over both suites', () => {
    expect(integrationArgs({})).toEqual([
      'test',
      '--preload',
      './test/integration/preload.ts',
      '--timeout',
      '30000',
      '--max-concurrency=1',
      ...INTEGRATION_SUITES,
    ]);
    expect(integrationArgs({ BHDEV_TEST_TIMEOUT_MS: '90000' })).toContain('90000');
  });

  it('keeps the suites with a name filter, and runs only the files named', () => {
    expect(integrationArgs({}, ['-t', 'vault'])).toEqual([
      ...integrationArgs({}).slice(0, 6),
      ...INTEGRATION_SUITES,
      '-t',
      'vault',
    ]);
    const one = integrationArgs({}, ['packages/core/test/integration/vault.test.ts']);
    expect(one.slice(6)).toEqual(['packages/core/test/integration/vault.test.ts']);
  });
});

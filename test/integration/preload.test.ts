/** @module test/integration/preload.test — the integration suites' timeout: 30 s by default, `BHDEV_TEST_TIMEOUT_MS` overrides, junk is ignored. */
import { describe, expect, it } from 'bun:test';
import { INTEGRATION_TIMEOUT_MS, integrationTimeoutMs } from './preload.ts';

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

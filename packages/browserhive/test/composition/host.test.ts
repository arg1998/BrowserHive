/** @module test/composition/host.test — `buildHostEnvironment` (frozen env copy, overrides) and the browser `HostFacts` slice. */

import { describe, expect, it } from 'bun:test';
import { buildHostEnvironment, hostFactsOf, LOG_MODULES } from '../../src/composition/index.ts';

describe('buildHostEnvironment', () => {
  it('freezes a copy of env and honours overrides', () => {
    const env: Record<string, string | undefined> = { LANG: 'de_DE.UTF-8' };
    const host = buildHostEnvironment({
      env,
      platform: 'linux',
      arch: 'arm64',
      release: '6.8.0',
      totalMemoryBytes: 1024,
      isTty: { stdout: true, stderr: false },
    });
    env['LANG'] = 'C';
    expect(host.env['LANG']).toBe('de_DE.UTF-8');
    expect(Object.isFrozen(host.env)).toBe(true);
    expect(host.totalMemoryBytes).toBe(1024);
    expect(host.isTty).toEqual({ stdout: true, stderr: false });
    expect(hostFactsOf(host)).toEqual({
      platform: 'linux',
      arch: 'arm64',
      release: '6.8.0',
      env: host.env,
    });
  });

  it('fills defaults from the running process', () => {
    const host = buildHostEnvironment({ env: {} });
    expect(host.cpuCount).toBeGreaterThan(0);
    expect(host.homeDir.length).toBeGreaterThan(0);
    expect(host.tmpDir.length).toBeGreaterThan(0);
    expect(LOG_MODULES).toContain('sessions');
  });
});

/** @module composition/adapters/preflight-degradation.test — a refused CORS preflight enforcement becomes one `PREFLIGHTS_NOT_ENFORCED` degradation (D-66, review F1). */

import { describe, expect, it } from 'bun:test';
import type { Degradation } from '@browserhive/core/runtime';
import type { PreflightEnforcement } from '@browserhive/core/server';
import { wirePreflightDegradation } from './preflight-degradation.ts';

function fakeSource(initial: PreflightEnforcement) {
  let listener: ((e: PreflightEnforcement) => void) | null = null;
  let verified = 0;
  return {
    source: {
      verify: () => {
        verified += 1;
        return initial;
      },
      onRefusal: (l: (e: PreflightEnforcement) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    },
    refuse: (e: PreflightEnforcement) => listener?.(e),
    verified: () => verified,
    listening: () => listener !== null,
  };
}

describe('wirePreflightDegradation', () => {
  it('checks the driver at boot and reports each refusal as an error degradation', () => {
    const reports: Degradation[] = [];
    const fake = fakeSource({ state: 'pending', reason: null, driverVersion: '1.63.0' });
    const stop = wirePreflightDegradation(
      { report: (d) => void reports.push(d), recovered: () => undefined },
      fake.source,
    );
    expect(fake.verified()).toBe(1);
    expect(reports).toEqual([]);
    fake.refuse({ state: 'refused', reason: 'driver_version', driverVersion: '1.99.0' });
    expect(reports).toEqual([
      {
        code: 'PREFLIGHTS_NOT_ENFORCED',
        severity: 'error',
        message:
          'Routed browsers cannot send real CORS preflights; they refuse cross-origin requests that need one.',
        details: { reason: 'driver_version', driver_version: '1.99.0' },
      },
    ]);
    stop();
    expect(fake.listening()).toBe(false);
  });
});

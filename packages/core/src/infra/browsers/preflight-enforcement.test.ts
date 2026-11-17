/** @module infra/browsers/preflight-enforcement.test — the verified driver version, the shared state and its refusal listeners (D-66, review F1/F6). */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  driverCoreVersion,
  isVerifiedDriverVersion,
  markPreflightsEnforced,
  onPreflightRefusal,
  type PreflightEnforcement,
  preflightEnforcement,
  refusePreflights,
  resetPreflightEnforcementForTests,
  sharedPreflightState,
  VERIFIED_DRIVER_VERSIONS,
  verifyPreflightDriver,
} from './preflight-enforcement.ts';

afterEach(() => resetPreflightEnforcementForTests());

describe('preflight enforcement', () => {
  it('the installed patchright-core is a verified version (a bump must re-verify the hook)', () => {
    const version = driverCoreVersion();
    expect(version).not.toBeNull();
    expect(VERIFIED_DRIVER_VERSIONS).toContain(version ?? '');
    expect(isVerifiedDriverVersion(version)).toBe(true);
    expect(isVerifiedDriverVersion('1.64.0')).toBe(false);
    expect(isVerifiedDriverVersion(null)).toBe(false);
    expect(verifyPreflightDriver().state).toBe('pending');
  });

  it('pending → enforced; a refusal is sticky and told to every listener once', () => {
    const seen: PreflightEnforcement[] = [];
    const stop = onPreflightRefusal((e) => seen.push(e));
    onPreflightRefusal(() => {
      throw new Error('a broken listener never stops the others');
    });
    expect(preflightEnforcement().state).toBe('pending');
    markPreflightsEnforced();
    expect(preflightEnforcement().state).toBe('enforced');
    refusePreflights('driver_shape');
    refusePreflights('unexpected_preflight');
    markPreflightsEnforced();
    expect(preflightEnforcement()).toMatchObject({ state: 'refused', reason: 'driver_shape' });
    expect(seen.map((e) => e.reason)).toEqual(['driver_shape']);
    stop();
    // A listener added after the refusal is told at once.
    const late: string[] = [];
    onPreflightRefusal((e) => late.push(e.state));
    expect(late).toEqual(['refused']);
  });

  it('one state for every copy of the module: kept on globalThis under a registered symbol', () => {
    const state = sharedPreflightState();
    expect(Reflect.get(globalThis, Symbol.for('browserhive.preflightEnforcement'))).toBe(state);
    expect(sharedPreflightState()).toBe(state);
  });
});

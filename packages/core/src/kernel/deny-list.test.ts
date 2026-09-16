/** @module kernel/deny-list.test — every deny-listed launch arg is rejected. */

import { describe, expect, it } from 'bun:test';
import {
  assertLaunchArgsAllowed,
  classifyLaunchArgs,
  DENIED_LAUNCH_ARG_KEYS,
  isDeniedLaunchArg,
  launchArgKey,
} from './deny-list.ts';
import { isAppError } from './errors/app-error.ts';

describe('launchArgKey', () => {
  it('trims and drops the =value suffix', () => {
    expect(launchArgKey('  --user-data-dir=/tmp/x ')).toBe('--user-data-dir');
    expect(launchArgKey('--no-sandbox')).toBe('--no-sandbox');
    expect(launchArgKey('--js-flags=--foo=bar')).toBe('--js-flags');
  });
});

describe('deny list', () => {
  it('lists exactly the denied keys', () => {
    expect(DENIED_LAUNCH_ARG_KEYS).toEqual([
      '--user-data-dir',
      '--profile-directory',
      '--disk-cache-dir',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-site-isolation-trials',
      '--disable-features',
      '--single-process',
      '--no-zygote',
      '--remote-debugging-port',
      '--remote-debugging-pipe',
      '--remote-debugging-address',
    ]);
  });

  it('rejects every entry, with or without a value', () => {
    for (const key of DENIED_LAUNCH_ARG_KEYS) {
      expect(isDeniedLaunchArg(key)).toBe(true);
      expect(isDeniedLaunchArg(`${key}=x`)).toBe(true);
      expect(isDeniedLaunchArg(`  ${key}`)).toBe(true);
    }
  });

  it('is case-sensitive and allows unrelated flags', () => {
    expect(isDeniedLaunchArg('--NO-SANDBOX')).toBe(false);
    expect(isDeniedLaunchArg('--window-size=1,1')).toBe(false);
    expect(isDeniedLaunchArg('https://example.com')).toBe(false);
  });

  it('classifyLaunchArgs names the first offender verbatim', () => {
    expect(classifyLaunchArgs(undefined)).toEqual({ ok: true, value: [] });
    expect(classifyLaunchArgs(['--a', '--b'])).toEqual({ ok: true, value: ['--a', '--b'] });
    expect(classifyLaunchArgs(['--a', ' --no-sandbox=1', '--user-data-dir'])).toEqual({
      ok: false,
      error: { arg: ' --no-sandbox=1' },
    });
  });

  it('assertLaunchArgsAllowed throws UNSAFE_LAUNCH_ARG with its public message', () => {
    expect(() => assertLaunchArgsAllowed(['--foo'])).not.toThrow();
    expect(() => assertLaunchArgsAllowed(undefined)).not.toThrow();
    try {
      assertLaunchArgsAllowed(['--remote-debugging-port=9222']);
      throw new Error('unreachable');
    } catch (error) {
      expect(isAppError(error, 'UNSAFE_LAUNCH_ARG')).toBe(true);
      if (isAppError(error, 'UNSAFE_LAUNCH_ARG')) {
        expect(error.details).toEqual({ arg: '--remote-debugging-port=9222' });
        expect(error.publicMessage).toBe(
          "Launch arg '--remote-debugging-port=9222' is on the deny-list and would break session isolation.",
        );
      }
    }
  });
});

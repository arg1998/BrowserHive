/** @module domain/policies/launch-options.test — pass-through validation: deny-list, unsafe fields, helper extractors. */

import { describe, expect, it } from 'bun:test';
import { isAppError } from '../../kernel/errors/app-error.ts';
import {
  executablePathOf,
  hasUserDataDir,
  launchArgsOf,
  parseContextOptions,
  parseLaunchOptions,
  storageStateName,
  UNSAFE_LAUNCH_OPTION_FIELDS,
} from './launch-options.ts';

describe('parseLaunchOptions', () => {
  it('returns undefined for absent input and forwards everything else', () => {
    expect(parseLaunchOptions(undefined)).toBeUndefined();
    expect(parseLaunchOptions(null)).toBeUndefined();
    expect(parseLaunchOptions({ args: ['--a'], slowMo: 1, executablePath: '/x' })).toEqual({
      args: ['--a'],
      slowMo: 1,
      executablePath: '/x',
    });
  });

  it('refuses deny-listed args by key (value ignored, first offender named)', () => {
    try {
      parseLaunchOptions({ args: ['--ok', '--user-data-dir=/tmp/x', '--no-sandbox'] });
      throw new Error('expected throw');
    } catch (err) {
      expect(isAppError(err, 'UNSAFE_LAUNCH_ARG')).toBe(true);
      if (isAppError(err, 'UNSAFE_LAUNCH_ARG'))
        expect(err.details.arg).toBe('--user-data-dir=/tmp/x');
    }
  });

  it('refuses each unsafe sibling field and chromiumSandbox:false', () => {
    for (const field of UNSAFE_LAUNCH_OPTION_FIELDS) {
      try {
        parseLaunchOptions({ [field]: 'x' });
        throw new Error('expected throw');
      } catch (err) {
        expect(isAppError(err, 'UNSAFE_LAUNCH_ARG')).toBe(true);
        if (isAppError(err, 'UNSAFE_LAUNCH_ARG')) expect(err.details.arg).toBe(field);
      }
    }
    expect(() => parseLaunchOptions({ chromiumSandbox: false })).toThrow();
    expect(parseLaunchOptions({ chromiumSandbox: true })).toEqual({ chromiumSandbox: true });
  });

  it('helper extractors', () => {
    expect(launchArgsOf({ args: ['--a', 1] })).toEqual(['--a']);
    expect(launchArgsOf({})).toBeUndefined();
    expect(hasUserDataDir({ userDataDir: '/p' })).toBe(true);
    expect(hasUserDataDir(undefined)).toBe(false);
    expect(executablePathOf({ executablePath: '/bin/chrome' })).toBe('/bin/chrome');
    expect(executablePathOf({})).toBeUndefined();
    expect(storageStateName(parseContextOptions({ storageState: 'name' }))).toBe('name');
    expect(storageStateName(parseContextOptions({ storageState: {} }))).toBeUndefined();
    expect(parseContextOptions(undefined)).toBeUndefined();
  });
});

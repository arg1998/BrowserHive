/** @module kernel/deny-list.test — every deny-listed launch arg is rejected, in every switch spelling Chromium accepts. */

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

  it('accepts every switch prefix Chromium accepts and lowercases the name', () => {
    expect(launchArgKey('-no-sandbox')).toBe('--no-sandbox');
    expect(launchArgKey('/no-sandbox')).toBe('--no-sandbox');
    expect(launchArgKey('--No-Sandbox')).toBe('--no-sandbox');
    expect(launchArgKey('-Remote-Debugging-Port=9222')).toBe('--remote-debugging-port');
    expect(launchArgKey('\u0085\t-no-sandbox　')).toBe('--no-sandbox');
  });

  it('strips exactly one prefix, longest first, like Chromium', () => {
    // Chromium reads `---no-sandbox` as the switch `-no-sandbox`, which is not `no-sandbox`.
    expect(launchArgKey('---no-sandbox')).toBe('---no-sandbox');
  });

  it('returns null for args Chromium does not treat as switches', () => {
    expect(launchArgKey('https://example.com')).toBeNull();
    expect(launchArgKey('no-sandbox')).toBeNull();
    expect(launchArgKey('-')).toBeNull();
    expect(launchArgKey('--')).toBeNull();
    expect(launchArgKey('/')).toBeNull();
    expect(launchArgKey('')).toBeNull();
  });
});

/** Every spelling of `key` (given as `--name`) that Chromium reads as the same switch on some platform. */
function spellingsOf(key: string): string[] {
  const name = key.slice(2);
  const upper = name.toUpperCase();
  const mixed = name.charAt(0).toUpperCase() + name.slice(1);
  return [
    `--${name}`,
    `-${name}`,
    `/${name}`,
    `--${upper}`,
    `-${mixed}`,
    `/${upper}`,
    `--${name}=value`,
    `-${name}=value`,
    `/${name}=value`,
    `-${name}=`,
    `  -${name}`,
    `\t/${name}=x  `,
    ` --${upper}=1 `,
  ];
}

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

  for (const key of DENIED_LAUNCH_ARG_KEYS) {
    it(`rejects ${key} in every switch spelling`, () => {
      for (const spelling of spellingsOf(key)) {
        expect({ spelling, denied: isDeniedLaunchArg(spelling) }).toEqual({
          spelling,
          denied: true,
        });
      }
    });
  }

  it('refuses a bare -- end-of-switches marker', () => {
    expect(isDeniedLaunchArg('--')).toBe(true);
    expect(isDeniedLaunchArg('  --  ')).toBe(true);
  });

  it('allows harmless args in any spelling', () => {
    for (const arg of [
      '--window-size=1,1',
      '-window-size=1,1',
      '/window-size=1,1',
      '--mute-audio',
      '--lang=de-DE',
      '--js-flags=--no-sandbox',
      '--enable-features=NetworkService',
      '--disable-blink-features=AutomationControlled',
      '--user-data-dir-suffix',
      '---no-sandbox',
      '-',
      'https://example.com',
      '/tmp/page.html',
    ]) {
      expect({ arg, denied: isDeniedLaunchArg(arg) }).toEqual({ arg, denied: false });
    }
  });

  it('classifyLaunchArgs names the first offender verbatim', () => {
    expect(classifyLaunchArgs(undefined)).toEqual({ ok: true, value: [] });
    expect(classifyLaunchArgs(['--a', '--b'])).toEqual({ ok: true, value: ['--a', '--b'] });
    expect(classifyLaunchArgs(['--a', ' --no-sandbox=1', '--user-data-dir'])).toEqual({
      ok: false,
      error: { arg: ' --no-sandbox=1' },
    });
    expect(classifyLaunchArgs(['--a', '-Remote-Debugging-Port=0'])).toEqual({
      ok: false,
      error: { arg: '-Remote-Debugging-Port=0' },
    });
  });

  it('assertLaunchArgsAllowed throws UNSAFE_LAUNCH_ARG with its public message', () => {
    expect(() => assertLaunchArgsAllowed(['--foo'])).not.toThrow();
    expect(() => assertLaunchArgsAllowed(undefined)).not.toThrow();
    for (const arg of ['--remote-debugging-port=9222', '-remote-debugging-port=9222']) {
      try {
        assertLaunchArgsAllowed([arg]);
        throw new Error('unreachable');
      } catch (error) {
        expect(isAppError(error, 'UNSAFE_LAUNCH_ARG')).toBe(true);
        if (isAppError(error, 'UNSAFE_LAUNCH_ARG')) {
          expect(error.details).toEqual({ arg });
          expect(error.publicMessage).toBe(
            `Launch arg '${arg}' is on the deny-list and would break session isolation.`,
          );
        }
      }
    }
  });
});

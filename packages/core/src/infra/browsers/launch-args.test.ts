/** @module infra/browsers/launch-args.test — arg merge order, the sandboxed-frames switch of a stealth launch and its one `--disable-features` switch, ignoreDefaultArgs rule and deny-list interplay. */

import { describe, expect, it } from 'bun:test';
import { DENIED_LAUNCH_ARG_KEYS } from '../../kernel/deny-list.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { launchKwargsForChannel } from './channel.ts';
import {
  AUTOMATION_ARG,
  buildLaunchOptions,
  executablePathWarning,
  mergeIgnoreDefaultArgs,
  STEALTH_ARGS,
} from './launch-args.ts';
import { assertLaunchOptionsAllowed, parseLaunchOptions } from './pass-through.ts';
import {
  ISOLATE_SANDBOXED_IFRAMES,
  PATCHRIGHT_DISABLE_FEATURES_ARG,
  PATCHRIGHT_DISABLED_FEATURES,
  SANDBOXED_FRAMES_IN_PROCESS_ARG,
} from './sandboxed-frames.ts';

const chrome = launchKwargsForChannel('chrome', { incognito: true, headless: true });
const chromium = launchKwargsForChannel('chromium', { incognito: false, headless: false });

describe('mergeIgnoreDefaultArgs', () => {
  it('leaves `true` alone, appends to an array, and creates the list when absent', () => {
    expect(mergeIgnoreDefaultArgs(true)).toBe(true);
    expect(mergeIgnoreDefaultArgs(['--foo'])).toEqual(['--foo', AUTOMATION_ARG]);
    expect(mergeIgnoreDefaultArgs([AUTOMATION_ARG])).toEqual([AUTOMATION_ARG]);
    expect(mergeIgnoreDefaultArgs(undefined)).toEqual([AUTOMATION_ARG]);
    expect(mergeIgnoreDefaultArgs(false)).toEqual([AUTOMATION_ARG]);
  });
});

describe('buildLaunchOptions', () => {
  it('merges args in the order channel → stealth → user and strips the controlled fields', () => {
    const { options, hasExecutablePath } = buildLaunchOptions({
      kwargs: chrome,
      stealth: true,
      launchOptions: { args: ['--mute-audio'], headless: false, channel: 'msedge', slowMo: 5 },
      proxy: null,
      downloadsDir: '/tmp/dl',
    });
    expect(options.args).toEqual([
      '--incognito',
      ...STEALTH_ARGS,
      '--mute-audio',
      SANDBOXED_FRAMES_IN_PROCESS_ARG,
    ]);
    // The controlled fields are re-applied by BrowserHive, never taken from the user.
    expect(options.headless).toBe(true);
    expect(options.channel).toBe('chrome');
    expect(options.slowMo).toBe(5);
    expect(options.ignoreDefaultArgs).toEqual([AUTOMATION_ARG]);
    expect(options.downloadsPath).toBe('/tmp/dl');
    expect(hasExecutablePath).toBe(false);
  });

  it('omits stealth args and ignoreDefaultArgs for a non-stealth session', () => {
    const { options } = buildLaunchOptions({
      kwargs: chromium,
      stealth: false,
      launchOptions: undefined,
      proxy: null,
      downloadsDir: '/tmp/dl',
    });
    expect(options.args).toBeUndefined();
    expect(options.ignoreDefaultArgs).toBeUndefined();
    expect(options.headless).toBe(false);
    expect(options.channel).toBe('chromium');
  });

  it('drops channel routing when the caller overrides executablePath', () => {
    const { options, hasExecutablePath } = buildLaunchOptions({
      kwargs: chromium,
      stealth: false,
      launchOptions: { executablePath: '/opt/chrome' },
      proxy: null,
      downloadsDir: '/tmp/dl',
    });
    expect(hasExecutablePath).toBe(true);
    expect(options.channel).toBeUndefined();
    expect(options.executablePath).toBe('/opt/chrome');
    const warning = executablePathWarning('/opt/chrome', 'chromium');
    expect(warning.code).toBe('EXECUTABLE_PATH_OVERRIDE');
    expect(warning.details).toEqual({ executablePath: '/opt/chrome', channel: 'chromium' });
  });

  it('applies the typed proxy as the single owner of egress', () => {
    const { options } = buildLaunchOptions({
      kwargs: chromium,
      stealth: true,
      launchOptions: { proxy: { server: 'http://raw:1' } },
      proxy: { server: 'http://p:8080', bypass: 'localhost', username: 'u', label: 'byo:p:8080' },
      downloadsDir: '/tmp/dl',
    });
    expect(options.proxy).toEqual({ server: 'http://p:8080', bypass: 'localhost', username: 'u' });
  });

  it('merges a user ignoreDefaultArgs array with the automation arg', () => {
    const { options } = buildLaunchOptions({
      kwargs: chromium,
      stealth: true,
      launchOptions: { ignoreDefaultArgs: ['--x'] },
      proxy: null,
      downloadsDir: '/tmp/dl',
    });
    expect(options.ignoreDefaultArgs).toEqual(['--x', AUTOMATION_ARG]);
  });
});

describe('buildLaunchOptions: one --disable-features switch (D-79)', () => {
  const build = (stealth: boolean, args?: string[], ignoreDefaultArgs?: string[] | boolean) =>
    buildLaunchOptions({
      kwargs: chromium,
      stealth,
      launchOptions: {
        ...(args !== undefined && { args }),
        ...(ignoreDefaultArgs !== undefined && { ignoreDefaultArgs }),
      },
      proxy: null,
      downloadsDir: '/tmp/dl',
    }).options.args ?? [];
  const switches = (args: readonly string[]) =>
    args.filter((arg) => /^--?disable-features(=|$)/.test(arg));

  it('a stealth launch keeps sandboxed frames in process; a plain one keeps the defaults', () => {
    expect(build(true)).toEqual([...STEALTH_ARGS, SANDBOXED_FRAMES_IN_PROCESS_ARG]);
    expect(build(false)).toEqual([]);
    expect(build(false, ['--mute-audio'])).toEqual(['--mute-audio']);
  });

  it("merges a user's own --disable-features with the stealth switch, last on the line", () => {
    for (const spelled of ['--disable-features', '-disable-features', '--Disable-Features']) {
      const args = build(true, [`${spelled}=Foo, Bar`, '--mute-audio']);
      expect(switches(args)).toEqual([
        `--disable-features=${[...PATCHRIGHT_DISABLED_FEATURES, ISOLATE_SANDBOXED_IFRAMES, 'Foo', 'Bar'].join(',')}`,
      ]);
      expect(args.at(-1)).toBe(switches(args)[0]);
      expect(args).toContain('--mute-audio');
    }
  });

  it("keeps Patchright's list under a user's own switch on a plain launch too", () => {
    expect(build(false, ['-disable-features=Foo'])).toEqual([
      `--disable-features=${[...PATCHRIGHT_DISABLED_FEATURES, 'Foo'].join(',')}`,
    ]);
    // A bare switch is an empty list: it would turn Patchright's off; folded, it changes nothing.
    expect(build(false, ['--disable-features'])).toEqual([PATCHRIGHT_DISABLE_FEATURES_ARG]);
  });

  it("leaves Patchright's list out when ignoreDefaultArgs drops Patchright's switch", () => {
    expect(switches(build(true, undefined, true))).toEqual([
      `--disable-features=${ISOLATE_SANDBOXED_IFRAMES}`,
    ]);
    expect(
      switches(build(true, ['--disable-features=Foo'], [PATCHRIGHT_DISABLE_FEATURES_ARG])),
    ).toEqual([`--disable-features=${ISOLATE_SANDBOXED_IFRAMES},Foo`]);
    // Other ignored defaults keep it.
    expect(switches(build(true, undefined, ['--x']))).toEqual([SANDBOXED_FRAMES_IN_PROCESS_ARG]);
  });
});

describe('deny-list interplay', () => {
  it('rejects every deny-listed key passed through user args, while stealth args bypass the check', () => {
    for (const key of DENIED_LAUNCH_ARG_KEYS) {
      expect(() => assertLaunchOptionsAllowed({ args: [`${key}=x`] })).toThrow();
      expect(() => assertLaunchOptionsAllowed({ args: [`-${key.slice(2)}=x`] })).toThrow();
    }
    // The internally-injected stealth arg is never deny-checked and never denied.
    expect(() => assertLaunchOptionsAllowed({ args: [...STEALTH_ARGS] })).not.toThrow();
    // The sandboxed-frames switch is BrowserHive's own, added after the check: a caller cannot pass it.
    expect(() => assertLaunchOptionsAllowed({ args: [SANDBOXED_FRAMES_IN_PROCESS_ARG] })).toThrow();
  });

  it('refuses the sibling loose fields with UNSAFE_LAUNCH_ARG naming the field', () => {
    for (const field of ['env', 'downloadsPath', 'recordVideo']) {
      try {
        parseLaunchOptions({ [field]: {} });
        throw new Error('expected to throw');
      } catch (err) {
        expect(isAppError(err, 'UNSAFE_LAUNCH_ARG')).toBe(true);
        if (isAppError(err, 'UNSAFE_LAUNCH_ARG')) expect(err.details.arg).toBe(field);
      }
    }
    for (const ignoreDefaultArgs of [
      true,
      ['--remote-debugging-pipe'],
      ['--password-store=basic'],
    ]) {
      expect(() => parseLaunchOptions({ ignoreDefaultArgs })).toThrow();
    }
    expect(() => parseLaunchOptions({ ignoreDefaultArgs: ['--enable-automation'] })).not.toThrow();
    expect(() => parseLaunchOptions({ chromiumSandbox: false })).toThrow();
    expect(() => parseLaunchOptions({ chromiumSandbox: true })).not.toThrow();
  });
});

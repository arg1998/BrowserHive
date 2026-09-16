/** @module infra/browsers/channel.test — channel → Playwright channel map and incognito rules. */

import { describe, expect, it } from 'bun:test';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { isChannel, launchKwargsForChannel, SUPPORTED_CHANNELS } from './channel.ts';

describe('channel → launch kwargs mapping', () => {
  it('exposes the supported channels', () => {
    expect(new Set(SUPPORTED_CHANNELS)).toEqual(new Set(['chrome', 'edge', 'chromium']));
  });

  it('chrome with incognito adds the --incognito flag', () => {
    const kwargs = launchKwargsForChannel('chrome', { incognito: true, headless: true });
    expect(kwargs.channel).toBe('chrome');
    expect(kwargs.headless).toBe(true);
    expect(kwargs.args).toEqual(['--incognito']);
  });

  it('edge maps to msedge', () => {
    const kwargs = launchKwargsForChannel('edge', { incognito: false, headless: true });
    expect(kwargs.channel).toBe('msedge');
    expect(kwargs.args).toBeUndefined();
  });

  it('edge incognito adds the flag and respects headless', () => {
    const kwargs = launchKwargsForChannel('edge', { incognito: true, headless: false });
    expect(kwargs.channel).toBe('msedge');
    expect(kwargs.headless).toBe(false);
    expect(kwargs.args).toEqual(['--incognito']);
  });

  it('chromium selects the full Chromium binary (channel: chromium, not the headless shell)', () => {
    const kwargs = launchKwargsForChannel('chromium', { incognito: false, headless: true });
    expect(kwargs.channel).toBe('chromium');
    expect(kwargs.headless).toBe(true);
  });

  it('chromium incognito is a no-op (isolation comes from newContext / userDataDir)', () => {
    const kwargs = launchKwargsForChannel('chromium', { incognito: true, headless: true });
    expect(kwargs.args).toBeUndefined();
  });

  it('throws UNKNOWN_CHANNEL with the stable public message for unsupported channels', () => {
    try {
      launchKwargsForChannel('firefox', { incognito: false, headless: true });
      throw new Error('expected to throw');
    } catch (err) {
      expect(isAppError(err, 'UNKNOWN_CHANNEL')).toBe(true);
      if (isAppError(err, 'UNKNOWN_CHANNEL')) {
        expect(err.publicMessage).toBe(
          "Unknown browser channel 'firefox'. Expected one of: chromium, chrome, edge.",
        );
        expect(err.details.supported).toEqual(['chromium', 'chrome', 'edge']);
      }
    }
  });
});

describe('isChannel type guard', () => {
  it('accepts the supported names', () => {
    expect(isChannel('chromium')).toBe(true);
    expect(isChannel('chrome')).toBe(true);
    expect(isChannel('edge')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isChannel('firefox')).toBe(false);
    expect(isChannel('webkit')).toBe(false);
    expect(isChannel('')).toBe(false);
  });
});

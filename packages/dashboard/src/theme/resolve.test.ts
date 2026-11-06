/** @module theme/resolve.test — the moved, React-free theme resolution behaves as before (04 §18.6) and `bootstrap` still re-exports it */
import { describe, expect, it } from 'bun:test';
import * as bootstrap from './bootstrap.ts';
import {
  parsePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './resolve.ts';

describe('theme/resolve', () => {
  it('resolves every preference against the OS setting', () => {
    const cases: ReadonlyArray<[ThemePreference, boolean, 'light' | 'dark']> = [
      ['system', true, 'dark'],
      ['system', false, 'light'],
      ['light', true, 'light'],
      ['light', false, 'light'],
      ['dark', true, 'dark'],
      ['dark', false, 'dark'],
    ];
    for (const [preference, prefersDark, resolved] of cases) {
      expect(resolveTheme(preference, prefersDark)).toBe(resolved);
    }
  });

  it('parses a stored preference; anything unknown is system', () => {
    expect(parsePreference('light')).toBe('light');
    expect(parsePreference('dark')).toBe('dark');
    expect(parsePreference('system')).toBe('system');
    expect(parsePreference('Dark')).toBe('system');
    expect(parsePreference(null)).toBe('system');
    expect(parsePreference(undefined)).toBe('system');
  });

  it('is the same function bootstrap exposes, with the same storage key', () => {
    expect(bootstrap.resolveTheme).toBe(resolveTheme);
    expect(bootstrap.parsePreference).toBe(parsePreference);
    expect(bootstrap.THEME_STORAGE_KEY).toBe(THEME_STORAGE_KEY);
    expect(THEME_STORAGE_KEY).toBe('bh.theme');
  });

  it('imports nothing (React-free, loadable by the offline page)', async () => {
    const source = await Bun.file(new URL('./resolve.ts', import.meta.url)).text();
    expect(source).not.toMatch(/^\s*import\b/m);
  });
});

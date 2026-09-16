/** @module theme/theme.test — no-FOUC bootstrap logic, matchMedia listener, data-theme + meta writes, persistence */
import '../../test/setup.ts';
import { describe, expect, it } from 'bun:test';
import { fakeThemeDom } from '../../test/helpers/theme-dom.ts';
import {
  nextPreference,
  parsePreference,
  resolveTheme,
  THEME_COLORS,
  THEME_STORAGE_KEY,
} from './bootstrap.ts';
import { ThemeStore } from './theme-store.ts';

describe('theme bootstrap', () => {
  it('resolves like the inline script', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(parsePreference('bogus')).toBe('system');
    expect(nextPreference('system')).toBe('light');
    expect(nextPreference('dark')).toBe('system');
  });

  it('mirrors the inline script constants in index.html', async () => {
    const html = await Bun.file(new URL('../../index.html', import.meta.url)).text();
    expect(html).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
    expect(html).toContain(`'${THEME_COLORS.dark}'`);
    expect(html).toContain(`'${THEME_COLORS.light}'`);
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<body>'));
  });
});

describe('ThemeStore', () => {
  it('applies the stored preference, follows the OS while on system, and persists changes', () => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    const dom = fakeThemeDom(true);
    const store = new ThemeStore(dom);
    expect(store.getState()).toEqual({ preference: 'system', resolved: 'dark' });
    expect(dom.root.getAttribute('data-theme')).toBe('dark');
    expect(dom.meta.getAttribute('content')).toBe(THEME_COLORS.dark);
    let changes = 0;
    store.subscribe(() => changes++);
    dom.media.set(false);
    expect(store.getState().resolved).toBe('light');
    expect(changes).toBe(1);
    store.set('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(dom.root.style.colorScheme).toBe('dark');
    dom.media.set(true);
    expect(changes).toBe(2);
    store.dispose();
    const again = new ThemeStore(fakeThemeDom(false));
    expect(again.getState()).toEqual({ preference: 'dark', resolved: 'dark' });
    localStorage.removeItem(THEME_STORAGE_KEY);
  });
});

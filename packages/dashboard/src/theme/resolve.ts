/** @module theme/resolve — the React-free theme resolution shared by the dashboard (`ThemeStore`) and the offline page (04 §4.4, §18.6). Pure; no imports. */

/** Operator preference. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** What is applied to `<html data-theme>`. */
export type ResolvedTheme = 'light' | 'dark';

/** `localStorage` key (spec 04 §4.4). */
export const THEME_STORAGE_KEY = 'bh.theme';

/** Parse a stored preference; anything unknown is `system`. */
export function parsePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** Resolve a preference against the OS setting. Identical to the inline bootstrap logic in `index.html`. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersDark ? 'dark' : 'light';
}

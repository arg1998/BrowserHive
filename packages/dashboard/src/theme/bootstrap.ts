/** @module theme/bootstrap — the pure theme resolution shared by the inline `index.html` script and `ThemeProvider` (no FOUC) */

/** Operator preference. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** What is applied to `<html data-theme>`. */
export type ResolvedTheme = 'light' | 'dark';

/** `localStorage` key (spec 04 §4.4). */
export const THEME_STORAGE_KEY = 'bh.theme';

/** `<meta name="theme-color">` values per theme; mirrored verbatim in `index.html`. */
export const THEME_COLORS: { readonly [T in ResolvedTheme]: string } = {
  light: '#f9fafb',
  dark: '#0b0c0e',
};

/** Parse a stored preference; anything unknown is `system`. */
export function parsePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** Resolve a preference against the OS setting. Identical to the inline bootstrap logic. */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersDark ? 'dark' : 'light';
}

/** Next preference when the topbar toggle cycles: system → light → dark → system. */
export function nextPreference(current: ThemePreference): ThemePreference {
  switch (current) {
    case 'system':
      return 'light';
    case 'light':
      return 'dark';
    case 'dark':
      return 'system';
    default:
      return 'system';
  }
}

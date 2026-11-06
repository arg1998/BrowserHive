/** @module theme/bootstrap — the theme constants shared by the inline `index.html` script and `ThemeProvider` (no FOUC); the pure resolution itself lives in `theme/resolve` */
import type { ResolvedTheme, ThemePreference } from './resolve.ts';

export {
  parsePreference,
  type ResolvedTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './resolve.ts';

/** `<meta name="theme-color">` values per theme; mirrored verbatim in `index.html`. */
export const THEME_COLORS: { readonly [T in ResolvedTheme]: string } = {
  light: '#f9fafb',
  dark: '#0b0c0e',
};

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

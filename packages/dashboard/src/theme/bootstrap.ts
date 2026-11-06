/** @module theme/bootstrap — the theme constants shared by the inline `index.html` script and `ThemeProvider` (no FOUC); the pure resolution and the theme colours live in `theme/resolve` */
import type { ThemePreference } from './resolve.ts';

export {
  parsePreference,
  type ResolvedTheme,
  resolveTheme,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './resolve.ts';

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

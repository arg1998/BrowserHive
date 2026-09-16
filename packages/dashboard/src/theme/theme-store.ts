/** @module theme/theme-store — per-app theme store: preference in localStorage, `matchMedia` listener, `data-theme` + meta theme-color writes */
import { readStorage, writeStorage } from '../lib/storage.ts';
import {
  parsePreference,
  type ResolvedTheme,
  resolveTheme,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './bootstrap.ts';

/** Observable theme state. */
export interface ThemeState {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
}

/** The DOM surface the store touches (injectable for tests). */
export interface ThemeDom {
  readonly matchMedia: (query: string) => MediaQueryList;
  readonly root: HTMLElement;
  readonly themeColorMeta: () => HTMLMetaElement | null;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Theme store. Constructed by `ThemeProvider`; never a module singleton. */
export class ThemeStore {
  private state: ThemeState;
  private readonly media: MediaQueryList;
  private readonly listeners = new Set<() => void>();
  private readonly onMediaChange = () => this.apply(this.state.preference);

  constructor(private readonly dom: ThemeDom) {
    this.media = dom.matchMedia(DARK_QUERY);
    const preference = parsePreference(readStorage(THEME_STORAGE_KEY));
    this.state = { preference, resolved: resolveTheme(preference, this.media.matches) };
    this.write(this.state.resolved);
    this.media.addEventListener('change', this.onMediaChange);
  }

  /** Current state. */
  getState(): ThemeState {
    return this.state;
  }

  /** Subscribe to changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Set and persist a preference. */
  set(preference: ThemePreference): void {
    writeStorage(THEME_STORAGE_KEY, preference);
    this.apply(preference);
  }

  /** Stop listening to the OS. */
  dispose(): void {
    this.media.removeEventListener('change', this.onMediaChange);
  }

  private apply(preference: ThemePreference): void {
    const resolved = resolveTheme(preference, this.media.matches);
    if (resolved === this.state.resolved && preference === this.state.preference) return;
    this.state = { preference, resolved };
    this.write(resolved);
    for (const listener of this.listeners) listener();
  }

  private write(resolved: ResolvedTheme): void {
    this.dom.root.setAttribute('data-theme', resolved);
    this.dom.root.style.colorScheme = resolved;
    const meta = this.dom.themeColorMeta();
    if (meta !== null) meta.setAttribute('content', THEME_COLORS[resolved]);
  }
}

/** The real DOM surface. */
export function browserThemeDom(): ThemeDom {
  return {
    matchMedia: (query) => window.matchMedia(query),
    root: document.documentElement,
    themeColorMeta: () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]'),
  };
}

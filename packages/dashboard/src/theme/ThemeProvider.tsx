/** @module theme/ThemeProvider — provides the theme store; `useTheme()` returns `{ preference, resolved, set }` (spec 04 §4.4) */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ThemePreference } from './bootstrap.ts';
import { browserThemeDom, type ThemeDom, ThemeStore } from './theme-store.ts';

/** What `useTheme()` returns. */
export interface ThemeApi {
  readonly preference: ThemePreference;
  readonly resolved: 'light' | 'dark';
  readonly set: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeStore | null>(null);

/** Props. `dom` is injectable for tests. */
export interface ThemeProviderProps {
  readonly children: ReactNode;
  readonly dom?: ThemeDom;
}

/** Owns one `ThemeStore` per app instance. */
export function ThemeProvider({ children, dom }: ThemeProviderProps) {
  const [store] = useState(() => new ThemeStore(dom ?? browserThemeDom()));
  useEffect(() => () => store.dispose(), [store]);
  return <ThemeContext.Provider value={store}>{children}</ThemeContext.Provider>;
}

/** Read and set the theme. */
export function useTheme(): ThemeApi {
  const store = useContext(ThemeContext);
  if (store === null) throw new Error('useTheme() requires ThemeProvider');
  const state = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState(),
    () => store.getState(),
  );
  return { preference: state.preference, resolved: state.resolved, set: (p) => store.set(p) };
}

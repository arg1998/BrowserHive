/** @module dashboard/test/helpers/theme-dom — controllable `ThemeDom` (matchMedia + root + meta) for theme tests */
import type { ThemeDom } from '@/theme/theme-store.ts';

/** A fake media query list whose `matches` can be flipped and whose listeners can be fired. */
export interface FakeMedia extends MediaQueryList {
  set(matches: boolean): void;
}

/** Build a fake `matchMedia` result. */
export function fakeMediaQuery(initial = false): FakeMedia {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches: initial,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    set(matches: boolean) {
      media.matches = matches;
      for (const listener of listeners)
        listener({ matches, media: media.media } as MediaQueryListEvent);
    },
  };
  return media as unknown as FakeMedia;
}

/** Fake DOM surface for `ThemeStore`. */
export function fakeThemeDom(
  prefersDark = false,
): ThemeDom & { readonly media: FakeMedia; readonly meta: HTMLMetaElement } {
  const media = fakeMediaQuery(prefersDark);
  const root = document.createElement('html');
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  return { matchMedia: () => media, root, themeColorMeta: () => meta, media, meta };
}

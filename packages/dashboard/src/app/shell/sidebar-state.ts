/** @module app/shell/sidebar-state — responsive band, sidebar pin preference (expanded/collapsed at every width ≥ 768, default by width), and the hover-peek timing machine */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { readStorage, writeStorage } from '@/lib/storage.ts';

/** Responsive band: `sm` < 768 (drawer) · `md` 768–1279 · `lg` 1280–1799 · `wide` ≥ 1800. */
export type ShellBand = 'sm' | 'md' | 'lg' | 'wide';

const QUERIES: { readonly [B in Exclude<ShellBand, 'sm'>]: string } = {
  md: '(min-width: 48rem)',
  lg: '(min-width: 80rem)',
  wide: '(min-width: 112.5rem)',
};

/** Width from which the sidebar defaults to expanded when no preference is stored. */
const EXPANDED_DEFAULT_QUERY = '(min-width: 64rem)';

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(query).matches;
}

function currentBand(): ShellBand {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'lg';
  if (matches(QUERIES.wide)) return 'wide';
  if (matches(QUERIES.lg)) return 'lg';
  if (matches(QUERIES.md)) return 'md';
  return 'sm';
}

function subscribeQueries(queries: readonly string[]) {
  return (cb: () => void): (() => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return () => undefined;
    }
    const lists = queries.map((q) => window.matchMedia(q));
    for (const list of lists) list.addEventListener('change', cb);
    return () => {
      for (const list of lists) list.removeEventListener('change', cb);
    };
  };
}

const subscribeBand = subscribeQueries(Object.values(QUERIES));
const subscribeWide = subscribeQueries([EXPANDED_DEFAULT_QUERY]);

/** The current shell band. */
export function useShellBand(): ShellBand {
  return useSyncExternalStore(subscribeBand, currentBand, () => 'lg');
}

/** `localStorage` key of the pin preference. */
export const SIDEBAR_KEY = 'bh.sidebar';

/** Sidebar preference. */
export type SidebarPreference = 'expanded' | 'collapsed';

/** Parse a stored value; anything else means "no preference". */
export function parseSidebarPreference(raw: string | null): SidebarPreference | null {
  return raw === 'expanded' || raw === 'collapsed' ? raw : null;
}

/** Effective state: the stored pin wins at every width; otherwise expanded from 1024px. */
export function resolveSidebar(
  stored: SidebarPreference | null,
  wideEnoughForExpanded: boolean,
): SidebarPreference {
  if (stored !== null) return stored;
  return wideEnoughForExpanded ? 'expanded' : 'collapsed';
}

const preferenceListeners = new Set<() => void>();

/** Effective sidebar state and a setter that pins it (persisted, shared across hook users). */
export function useSidebarPreference(): readonly [
  SidebarPreference,
  (next: SidebarPreference) => void,
] {
  const stored = useSyncExternalStore(
    (cb) => {
      preferenceListeners.add(cb);
      return () => {
        preferenceListeners.delete(cb);
      };
    },
    () => parseSidebarPreference(readStorage(SIDEBAR_KEY)),
    () => null,
  );
  const wide = useSyncExternalStore(
    subscribeWide,
    () => matches(EXPANDED_DEFAULT_QUERY),
    () => true,
  );
  const set = useCallback((next: SidebarPreference) => {
    writeStorage(SIDEBAR_KEY, next);
    for (const listener of preferenceListeners) listener();
  }, []);
  return [resolveSidebar(stored, wide), set];
}

/** Hover-peek timings. */
export const PEEK_OPEN_DELAY_MS = 200;
/** Grace period after the pointer leaves the peek overlay. */
export const PEEK_CLOSE_GRACE_MS = 300;

/**
 * Hover-peek over the collapsed rail: opens `openDelay` after the pointer enters the rail, stays
 * open while the pointer is over the rail or the overlay, and closes `closeGrace` after it leaves
 * both (so a diagonal move toward a nav item never closes it).
 */
export function useHoverPeek(
  enabled: boolean,
  openDelay = PEEK_OPEN_DELAY_MS,
  closeGrace = PEEK_CLOSE_GRACE_MS,
): {
  readonly peeking: boolean;
  readonly onEnter: () => void;
  readonly onLeave: () => void;
  readonly close: () => void;
} {
  const [peeking, setPeeking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clear, [clear]);
  useEffect(() => {
    if (!enabled) {
      clear();
      setPeeking(false);
    }
  }, [enabled, clear]);
  const onEnter = useCallback(() => {
    if (!enabled) return;
    clear();
    if (!peeking) timer.current = setTimeout(() => setPeeking(true), openDelay);
  }, [enabled, peeking, openDelay, clear]);
  const onLeave = useCallback(() => {
    clear();
    if (peeking) timer.current = setTimeout(() => setPeeking(false), closeGrace);
  }, [peeking, closeGrace, clear]);
  const close = useCallback(() => {
    clear();
    setPeeking(false);
  }, [clear]);
  return { peeking: enabled && peeking, onEnter, onLeave, close };
}

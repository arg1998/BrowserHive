/** @module features/logs/use-media-query — subscribe to a CSS media query (the Logs toolbar swaps its desktop chips for a compact Filters menu on phones) */
import { useCallback, useSyncExternalStore } from 'react';

/** `true` while `query` matches; `false` where `matchMedia` is unavailable. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

/** Below Tailwind's `sm` breakpoint (640px). */
export const PHONE_QUERY = '(max-width: 639.98px)';

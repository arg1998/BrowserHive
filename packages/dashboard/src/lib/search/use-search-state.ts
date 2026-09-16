/** @module lib/search/use-search-state — read the route's search params and write patches with replace-history semantics (spec 04 §12) */
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';
import { applySearchPatch } from './table.ts';

/** Search state accessor for the current route. */
export interface SearchState<S extends Record<string, unknown>> {
  readonly search: S;
  /** Merge a patch (filter changes reset `page`; `undefined` removes a key). */
  readonly set: (patch: Partial<Record<keyof S & string, unknown>>) => void;
  /** Remove every key except the ones listed (defaults fill back in). */
  readonly clear: (keep?: readonly (keyof S & string)[]) => void;
}

/**
 * Hook over TanStack Router search params. Route files declare `validateSearch` (zod schema) and
 * `search.middlewares: [stripSearchParams(DEFAULTS)]` so defaults never reach the URL.
 */
export function useSearchState<S extends Record<string, unknown>>(): SearchState<S> {
  // The validated search of the matched routes, with defaults applied. `location.search` is the raw
  // URL and lacks the defaults that `stripSearchParams` removes (e.g. `page: 1`).
  const validated = useSearch({ strict: false });
  // Each route's validateSearch guarantees the shape its page component reads.
  const search = validated as unknown as S;
  const navigate = useNavigate();
  const set = useCallback(
    (patch: Partial<Record<keyof S & string, unknown>>) => {
      void navigate({
        to: '.',
        replace: true,
        search: (prev: Record<string, unknown>) => applySearchPatch(prev, patch),
      });
    },
    [navigate],
  );
  const clear = useCallback(
    (keep: readonly (keyof S & string)[] = []) => {
      void navigate({
        to: '.',
        replace: true,
        search: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = {};
          for (const key of keep) if (prev[key] !== undefined) next[key] = prev[key];
          return next;
        },
      });
    },
    [navigate],
  );
  return { search, set, clear };
}

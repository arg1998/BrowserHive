/** @module components/shared/use-cursor-pages — maps URL `page` numbers onto the keyset-cursor collection API: remembers each page's `next_cursor` per filter set and walks forward when a page is requested out of order (spec 03 §5, spec 04 §12) */
import { useCallback, useRef } from 'react';

/** The slice of a collection envelope the pager needs. */
export interface CursorPage {
  readonly page: { readonly next_cursor: string | null };
}

/** Fetch one page starting at `cursor` (`undefined` = first page). */
export type PageFetcher<T extends CursorPage> = (cursor: string | undefined) => Promise<T>;

/** Resolve page `n` of a cursor-paged list. */
export interface CursorPager {
  /** Fetch page `page` (1-based) for the filter set identified by `key`, walking from the closest known page. */
  readonly resolve: <T extends CursorPage>(
    key: string,
    page: number,
    fetchPage: PageFetcher<T>,
  ) => Promise<T>;
  /** Forget every cursor of `key` (or all keys) — call after a live insert changed the ordering. */
  readonly reset: (key?: string) => void;
}

/**
 * Cursor chain per filter key: `chain[i]` is the cursor that starts page `i + 2` (page 1 has none).
 * A page beyond the chain is reached by walking from the last known page; `Infinity`-style jumps
 * are bounded by the caller's clamped pager.
 */
export function useCursorPager(): CursorPager {
  const chains = useRef(new Map<string, string[]>());
  const resolve = useCallback(
    async <T extends CursorPage>(key: string, page: number, fetchPage: PageFetcher<T>) => {
      const chain = chains.current.get(key) ?? [];
      const target = Math.max(1, page);
      // Highest page whose start cursor we know: page 1 always, page i + 2 when chain[i] exists.
      let current = Math.min(target, chain.length + 1);
      let cursor = current === 1 ? undefined : chain[current - 2];
      let result = await fetchPage(cursor);
      while (current < target) {
        const next = result.page.next_cursor;
        if (next === null) break;
        chain[current - 1] = next;
        cursor = next;
        current += 1;
        result = await fetchPage(cursor);
      }
      if (result.page.next_cursor !== null) chain[current - 1] = result.page.next_cursor;
      chains.current.set(key, chain);
      return result;
    },
    [],
  );
  const reset = useCallback((key?: string) => {
    if (key === undefined) chains.current.clear();
    else chains.current.delete(key);
  }, []);
  return { resolve, reset };
}

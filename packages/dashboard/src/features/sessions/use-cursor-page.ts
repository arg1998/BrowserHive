/** @module features/sessions/use-cursor-page — page numbers over keyset cursors: remembers `next_cursor` per (signature, page) so the URL `page` maps onto a cursor; unknown pages fall back to 1 (spec 03 §5) */
import { useCallback, useEffect, useRef } from 'react';

/** What a table needs to fetch its page. */
export interface CursorPage {
  /** Cursor for the requested page (`undefined` on page 1). */
  readonly cursor: string | undefined;
  /** `false` when the page is > 1 and its cursor was never seen (cold URL). */
  readonly known: boolean;
  /** Record the cursor that leads from `page` to `page + 1`. */
  readonly remember: (page: number, nextCursor: string | null) => void;
}

/**
 * Track cursors for a page chain. `signature` is anything that changes the result set (filters,
 * sort, page size); a new signature forgets every cursor. When the requested page is unknown,
 * `onUnknown` is called (callers reset `page` in the URL).
 */
export function useCursorPage(signature: string, page: number, onUnknown: () => void): CursorPage {
  const cursors = useRef<{ signature: string; map: Map<number, string> }>({
    signature,
    map: new Map(),
  });
  if (cursors.current.signature !== signature) {
    cursors.current = { signature, map: new Map() };
  }
  const cursor = page <= 1 ? undefined : cursors.current.map.get(page);
  const known = page <= 1 || cursor !== undefined;
  const onUnknownRef = useRef(onUnknown);
  onUnknownRef.current = onUnknown;
  useEffect(() => {
    if (!known) onUnknownRef.current();
  }, [known]);
  const remember = useCallback((forPage: number, nextCursor: string | null) => {
    if (nextCursor === null) cursors.current.map.delete(forPage + 1);
    else cursors.current.map.set(forPage + 1, nextCursor);
  }, []);
  return { cursor, known, remember };
}

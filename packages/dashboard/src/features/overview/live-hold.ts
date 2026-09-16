/** @module features/overview/live-hold — keep live lists still while someone reads them: while the reader is scrolled, hovering or focused inside a list, live inserts and re-ordering updates are held behind an "N new" pill instead of pushing the rows being read (the sessions Activity pattern for plain lists and tables) */
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** A frozen view of a list: row order plus each row's version when it was taken. */
export interface FrozenOrder {
  readonly ids: readonly string[];
  readonly versions: ReadonlyMap<string, number>;
}

/** What a held list shows. */
export interface HeldRows<T> {
  /** Rows to render: the frozen order (with current contents) while held, else the live rows. */
  readonly shown: readonly T[];
  /** Rows not yet shown in place: new ones plus ones that changed position since the freeze. */
  readonly pending: number;
  /** Of `pending`, how many are brand new. */
  readonly added: number;
}

/**
 * Apply a frozen order to the live rows (pure). Rows that left the live list disappear (a dismissal
 * is the reader's own action); rows the freeze has not seen are held back; rows whose version grew
 * keep their frozen slot but count as pending (they would move up on release).
 */
export function applyFrozenOrder<T>(
  rows: readonly T[],
  frozen: FrozenOrder | null,
  getId: (row: T) => string,
  getVersion?: (row: T) => number,
): HeldRows<T> {
  if (frozen === null) return { shown: rows, pending: 0, added: 0 };
  const byId = new Map(rows.map((row) => [getId(row), row] as const));
  const shown: T[] = [];
  let moved = 0;
  for (const id of frozen.ids) {
    const row = byId.get(id);
    if (row === undefined) continue;
    shown.push(row);
    const before = frozen.versions.get(id);
    if (getVersion !== undefined && before !== undefined && getVersion(row) > before) moved += 1;
  }
  const added = rows.length - shown.length;
  return { shown, pending: added + moved, added };
}

/** Freeze a list as it is now. */
export function freezeOrder<T>(
  rows: readonly T[],
  getId: (row: T) => string,
  getVersion?: (row: T) => number,
): FrozenOrder {
  return {
    ids: rows.map(getId),
    versions: new Map(rows.map((row) => [getId(row), getVersion?.(row) ?? 0] as const)),
  };
}

/**
 * `true` while the reader is engaged with the element: the page is scrolled away from the top, or
 * the pointer is over it, or focus is inside it. Any of these means rows moving would be felt.
 */
export function useReading(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolled, setScrolled] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      setScrolled(window.scrollY > 0);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);
  // Delegated on the document: the list element may mount later than the hook (after its data).
  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      target instanceof Node && ref.current !== null && ref.current.contains(target);
    const over = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') setHovering(inside(event.target));
    };
    const out = (event: PointerEvent) => {
      if (event.relatedTarget === null) setHovering(false);
    };
    const focusIn = (event: FocusEvent) => setFocused(inside(event.target));
    const focusOut = (event: FocusEvent) => {
      if (!inside(event.relatedTarget)) setFocused(false);
    };
    document.addEventListener('pointerover', over, { passive: true });
    document.addEventListener('pointerout', out, { passive: true });
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
    };
  }, [ref]);
  return scrolled || hovering || focused;
}

/** Options. */
export interface LiveHoldOptions<T> {
  readonly getId: (row: T) => string;
  /** Monotonic version (e.g. `updated_at`) whose growth re-orders the row; omit for append-only lists. */
  readonly getVersion?: (row: T) => number;
  /** Identity of the list (filters, page, sort): a change drops the freeze. */
  readonly listKey: string;
  /** Freeze only when live inserts can land here (e.g. the first page in newest-first order). */
  readonly enabled?: boolean;
}

/**
 * Hold live changes to `rows` while the reader is engaged with `ref`. Returns what to render, how
 * many changes wait, and `release` for the pill (which also scrolls the list into view).
 */
export function useLiveHold<T>(
  rows: readonly T[],
  ref: RefObject<HTMLElement | null>,
  { getId, getVersion, listKey, enabled = true }: LiveHoldOptions<T>,
) {
  const reading = useReading(ref) && enabled;
  const [frozen, setFrozen] = useState<FrozenOrder | null>(null);
  const latest = useRef({ rows, getId, getVersion });
  latest.current = { rows, getId, getVersion };
  // Freeze on engagement, thaw on disengagement (the list catches up while nobody is looking).
  useEffect(() => {
    if (!reading) {
      setFrozen(null);
      return;
    }
    const { rows: current, getId: id, getVersion: version } = latest.current;
    setFrozen((existing) => existing ?? freezeOrder(current, id, version));
  }, [reading]);
  // A different list (filters, page) is never shown through an old freeze.
  const keyRef = useRef(listKey);
  useEffect(() => {
    if (keyRef.current === listKey) return;
    keyRef.current = listKey;
    const { rows: current, getId: id, getVersion: version } = latest.current;
    setFrozen((existing) => (existing === null ? null : freezeOrder(current, id, version)));
  }, [listKey]);
  const held = useMemo(() => {
    const applied = applyFrozenOrder(rows, frozen, getId, getVersion);
    // Nothing of the freeze is left (data replaced wholesale): show the live list.
    return applied.shown.length === 0 && rows.length > 0
      ? { shown: rows, pending: 0, added: 0 }
      : applied;
  }, [rows, frozen, getId, getVersion]);
  const release = useCallback(() => {
    const { rows: current, getId: id, getVersion: version } = latest.current;
    setFrozen(reading ? freezeOrder(current, id, version) : null);
    const node = ref.current;
    if (node === null) return;
    // Bring the top of the list back into view when it sits under the sticky topbar.
    const topbar = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 3.5;
    const top = node.getBoundingClientRect().top;
    if (top < topbar) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      window.scrollTo({
        top: Math.max(0, window.scrollY + top - topbar - 16),
        behavior: reduce ? 'auto' : 'smooth',
      });
    }
  }, [reading, ref]);
  return { ...held, release };
}

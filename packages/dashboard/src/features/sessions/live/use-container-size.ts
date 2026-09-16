/** @module features/sessions/live/use-container-size — ResizeObserver-backed element size: the first observation lands at once (the stream starts at the pane's real size), later ones are debounced (250 ms) so pane drags do not spam `set_size` */
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { Size } from './input-mapping.ts';

/** How long to wait for a first measurement before answering `fallback` (an element with no layout). */
const FIRST_MEASURE_TIMEOUT_MS = 300;

/**
 * Observed size of `ref`, `null` until the element has been measured. Without `ResizeObserver`, or
 * when no non-empty size arrives in time (no layout, e.g. a DOM test environment), it answers
 * `fallback` so callers never wait forever.
 */
export function useContainerSize(
  ref: RefObject<HTMLElement | null>,
  fallback: Size,
  debounceMs = 250,
): Size | null {
  const [size, setSize] = useState<Size | null>(() =>
    typeof ResizeObserver === 'function' ? null : fallback,
  );
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver !== 'function') return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first = true;
    const giveUp = setTimeout(() => {
      if (!first) return;
      first = false;
      setSize((prev) => prev ?? fallbackRef.current);
    }, FIRST_MEASURE_TIMEOUT_MS);
    const apply = (width: number, height: number) =>
      setSize((prev) =>
        prev !== null && prev.width === width && prev.height === height ? prev : { width, height },
      );
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined || rect.width === 0 || rect.height === 0) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (first) {
        first = false;
        clearTimeout(giveUp);
        apply(width, height);
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => apply(width, height), debounceMs);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      clearTimeout(giveUp);
      if (timer !== null) clearTimeout(timer);
    };
  }, [ref, debounceMs]);
  return size;
}

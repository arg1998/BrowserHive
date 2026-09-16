/** @module components/shared/use-image-zoom — zoom/pan state for `ImageZoomModal`: clamped zoom, wheel-to-cursor, drag pan, `+ = - 0` shortcuts in the modal scope, reset on open/src change */
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useKeyboardScope, useShortcut } from '@/app/providers/KeyboardProvider.tsx';

/** Zoom bounds, the button/key step factor and the double-click toggle zoom. */
export const ZOOM = { min: 0.25, max: 8, step: 1.25, toggle: 2.4 } as const;

/** Clamp a zoom factor to the allowed band. */
export function clampZoom(zoom: number): number {
  return Math.min(ZOOM.max, Math.max(ZOOM.min, zoom));
}

/** Offset that keeps the point under the cursor fixed while the zoom changes from `prev` to `next`. */
export function anchoredOffset(
  offset: { readonly x: number; readonly y: number },
  cursor: { readonly x: number; readonly y: number },
  prev: number,
  next: number,
): { readonly x: number; readonly y: number } {
  const ratio = next / prev;
  return {
    x: cursor.x - (cursor.x - offset.x) * ratio,
    y: cursor.y - (cursor.y - offset.y) * ratio,
  };
}

/** Zoom/pan state bound to an open flag and an image source. */
export function useImageZoom(open: boolean, src: string) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  const dragFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const reset = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);
  const zoomBy = useCallback((factor: number) => setZoom((z) => clampZoom(z * factor)), []);

  // Reopening or swapping the image always starts from a clean fit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `src` resets the view on image change
  useEffect(() => {
    if (open) {
      reset();
      setFailed(false);
    }
  }, [open, src, reset]);

  // Geometry goes through CSS variables so the element carries no inline style attribute.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img === null) return;
    img.style.setProperty('--zoom', String(zoom));
    img.style.setProperty('--pan-x', `${offset.x}px`);
    img.style.setProperty('--pan-y', `${offset.y}px`);
  }, [zoom, offset]);

  useKeyboardScope('modal', open);
  useShortcut(
    {
      id: 'zoom.in',
      combo: '+',
      description: 'Zoom in',
      scope: 'modal',
      group: 'Image',
      handler: () => void zoomBy(ZOOM.step),
    },
    open,
  );
  useShortcut(
    {
      id: 'zoom.in.eq',
      combo: '=',
      description: 'Zoom in',
      scope: 'modal',
      handler: () => void zoomBy(ZOOM.step),
    },
    open,
  );
  useShortcut(
    {
      id: 'zoom.out',
      combo: '-',
      description: 'Zoom out',
      scope: 'modal',
      group: 'Image',
      handler: () => void zoomBy(1 / ZOOM.step),
    },
    open,
  );
  useShortcut(
    {
      id: 'zoom.fit',
      combo: '0',
      description: 'Fit image',
      scope: 'modal',
      group: 'Image',
      handler: () => void reset(),
    },
    open,
  );

  // Wheel-to-zoom toward the cursor (React's onWheel is passive, so bind natively).
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!open || surface === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = surface.getBoundingClientRect();
      const cursor = {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      };
      setZoom((prev) => {
        const next = clampZoom(prev * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
        setOffset((o) => anchoredOffset(o, cursor, prev, next));
        return next;
      });
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  }, [open]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragFrom.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current;
    if (from === null) return;
    setOffset({ x: from.ox + (event.clientX - from.x), y: from.oy + (event.clientY - from.y) });
  };
  const onPointerUp = (): void => {
    dragFrom.current = null;
    setDragging(false);
  };

  return {
    zoom,
    dragging,
    failed,
    setFailed,
    reset,
    zoomBy,
    surfaceRef,
    imgRef,
    pointer: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick: () => (zoom === 1 ? zoomBy(ZOOM.toggle) : reset()),
    },
  };
}

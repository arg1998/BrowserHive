/** @module features/sessions/live/stream-size — per-viewer screencast size: presets (`fit | 720p | 1080p | native`), DPR cap 2×, bounds 64–7680, last-used preset in localStorage (spec 04 §12.3.1, §13) */
import { SCREENCAST_MAX_DIMENSION } from '@browserhive/contracts/ws';
import { readStorage, writeStorage } from '@/lib/storage.ts';
import { STREAM_SIZES, type StreamSize } from '../detail-search.ts';

/** localStorage key for the last-used size preset. */
export const STREAM_SIZE_STORAGE_KEY = 'bh.liveView.size';
/** Debounce for `screencast.set_size` on pane resize. */
export const SET_SIZE_DEBOUNCE_MS = 250;

const MIN = 64;
const clamp = (n: number) => Math.max(MIN, Math.min(SCREENCAST_MAX_DIMENSION, Math.round(n)));

/** Requested max dims for a preset inside a container at a device pixel ratio. */
export function streamDims(
  size: StreamSize,
  container: { readonly width: number; readonly height: number },
  dpr: number,
): { readonly max_width: number; readonly max_height: number } {
  switch (size) {
    case '720p':
      return { max_width: 1280, max_height: 720 };
    case '1080p':
      return { max_width: 1920, max_height: 1080 };
    case 'native':
      return { max_width: 3840, max_height: 2160 };
    case 'fit': {
      const scale = Math.min(2, Math.max(1, dpr));
      return {
        max_width: clamp(container.width * scale),
        max_height: clamp(container.height * scale),
      };
    }
    default:
      return { max_width: 1280, max_height: 720 };
  }
}

/** Last-used preset (default `fit`). */
export function readStoredSize(): StreamSize {
  const raw = readStorage(STREAM_SIZE_STORAGE_KEY);
  return STREAM_SIZES.find((s) => s === raw) ?? 'fit';
}

/** Persist the preset. */
export function storeSize(size: StreamSize): void {
  writeStorage(STREAM_SIZE_STORAGE_KEY, size);
}

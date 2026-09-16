/** @module components/shared/use-density — table density preference (comfortable 44px / compact 36px rows), shared by every table on this device */
import { useCallback, useSyncExternalStore } from 'react';
import { readStorage, writeStorage } from '@/lib/storage.ts';

/** Row density. */
export type Density = 'comfortable' | 'compact';

const KEY = 'bh.density';
const listeners = new Set<() => void>();

function read(): Density {
  return readStorage(KEY) === 'compact' ? 'compact' : 'comfortable';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current density and a setter (persists to localStorage and updates every table). */
export function useDensity(): readonly [Density, (next: Density) => void] {
  const value = useSyncExternalStore(subscribe, read, () => 'comfortable' as const);
  const set = useCallback((next: Density) => {
    writeStorage(KEY, next);
    for (const listener of listeners) listener();
  }, []);
  return [value, set];
}

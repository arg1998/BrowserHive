/** @module interface/mcp/sealed-storage — the storage values a sealed template session's pages hold (spec 13 §5.4, §14: a localStorage or IndexedDB value of the template's sites never reaches an agent result): read from the session's own pages on the template's sites, redacted like cookie values. */

import type { Page } from '../../ports/page-types.ts';

/** How long one page may take to report its storage before it is skipped for this result. */
export const STORAGE_READ_MS = 1_000;
/** Pages read per result at most. */
const MAX_PAGES = 10;

/**
 * Runs in the page: every string of local and session storage and of IndexedDB (each object
 * store's first records, strings at any depth up to 6), at least `min` characters, at most `cap`.
 * Opening a database without a version never upgrades or creates it.
 */
async function collectStorage(args: { min: number; cap: number }): Promise<string[]> {
  const out = new Set<string>();
  const add = (value: unknown, depth: number): void => {
    if (out.size >= args.cap || depth > 6) return;
    if (typeof value === 'string') {
      if (value.length >= args.min) out.add(value);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const item of Array.isArray(value) ? value : Object.values(value)) add(item, depth + 1);
  };
  for (const store of [localStorage, sessionStorage]) {
    for (let i = 0; i < store.length; i++) add(store.getItem(store.key(i) ?? ''), 0);
  }
  const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => n !== undefined);
  for (const name of names) {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    });
    if (db === null) continue;
    try {
      for (const storeName of Array.from(db.objectStoreNames)) {
        const records = await new Promise<unknown[]>((resolve) => {
          const request = db
            .transaction(storeName, 'readonly')
            .objectStore(storeName)
            .getAll(null, 200);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve([]);
        });
        add(records, 0);
      }
    } finally {
      db.close();
    }
  }
  return [...out];
}

/** Resolves `null` after `ms`. */
function timeout(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });
}

/**
 * The storage values of `pages` whose origin belongs to one of `sites` (registrable domains), at
 * least `min` characters. A page that does not answer in {@link STORAGE_READ_MS} is skipped.
 */
export async function storageValues(
  pages: readonly Page[],
  isSite: (url: string) => boolean,
  min: number,
): Promise<string[]> {
  const read = pages
    .filter((page) => !page.isClosed() && isSite(page.url()))
    .slice(0, MAX_PAGES)
    .map(async (page) => {
      try {
        const values = await Promise.race([
          page.evaluate(collectStorage, { min, cap: 500 }),
          timeout(STORAGE_READ_MS),
        ]);
        return values ?? [];
      } catch {
        return [];
      }
    });
  return (await Promise.all(read)).flat();
}

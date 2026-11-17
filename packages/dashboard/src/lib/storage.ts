/** @module lib/storage — try/catch Web Storage access (spec 04 §4.6): `localStorage` for per-device conveniences, `sessionStorage` for work in progress that belongs to one tab and one sign-in (gone when the tab closes, cleared on sign-out) */

/** Which store: `local` (per device, survives restarts) or `session` (this tab only). */
export type StorageArea = 'local' | 'session';

function area(which: StorageArea): Storage {
  return which === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
}

/** Read a string; `null` when absent or storage is unavailable. */
export function readStorage(key: string, which: StorageArea = 'local'): string | null {
  try {
    return area(which).getItem(key);
  } catch {
    return null;
  }
}

/** Write a string; failures (quota, private mode) are silent by design. */
export function writeStorage(key: string, value: string, which: StorageArea = 'local'): void {
  try {
    area(which).setItem(key, value);
  } catch {
    // Persistence is best-effort (spec 04 §4.6).
  }
}

/** Remove a key; failures are silent. */
export function removeStorage(key: string, which: StorageArea = 'local'): void {
  try {
    area(which).removeItem(key);
  } catch {
    // Persistence is best-effort (spec 04 §4.6).
  }
}

/** Read JSON through a validator; `null` when absent, unparsable or invalid. */
export function readStorageJson<T>(
  key: string,
  validate: (raw: unknown) => T | null,
  which: StorageArea = 'local',
): T | null {
  const raw = readStorage(key, which);
  if (raw === null) return null;
  try {
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Write a JSON-serialisable value. */
export function writeStorageJson(key: string, value: unknown, which: StorageArea = 'local'): void {
  writeStorage(key, JSON.stringify(value), which);
}

/**
 * Forget this tab's work in progress: every `bh.` key in `sessionStorage` (the template wizard's
 * draft). Runs when the operator signs out or the server ends the session (a 401).
 */
export function clearTabStorage(): void {
  try {
    const store = globalThis.sessionStorage;
    const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter(
      (key): key is string => key?.startsWith('bh.') === true,
    );
    for (const key of keys) store.removeItem(key);
  } catch {
    // Persistence is best-effort (spec 04 §4.6).
  }
}

/** Keys earlier builds kept in `localStorage` that now live only in a tab; removed at start. */
const RETIRED_LOCAL_KEYS = ['bh.templateDraft'] as const;

/** Remove the retired `localStorage` keys (an old template draft must not outlive this build). */
export function dropRetiredStorage(): void {
  for (const key of RETIRED_LOCAL_KEYS) removeStorage(key);
}

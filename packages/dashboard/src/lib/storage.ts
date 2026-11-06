/** @module lib/storage — try/catch `localStorage` and `sessionStorage` access for per-device and per-tab conveniences (spec 04 §4.6, §18.4) */

/** The two Web Storage areas. Reading the global itself can throw (blocked site data), so it is resolved inside the try. */
type StorageArea = 'localStorage' | 'sessionStorage';

function readFrom(area: StorageArea, key: string): string | null {
  try {
    return globalThis[area].getItem(key);
  } catch {
    return null;
  }
}

function writeTo(area: StorageArea, key: string, value: string): boolean {
  try {
    globalThis[area].setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeFrom(area: StorageArea, key: string): void {
  try {
    globalThis[area].removeItem(key);
  } catch {
    // Persistence is best-effort (spec 04 §4.6).
  }
}

function readJsonFrom<T>(
  area: StorageArea,
  key: string,
  validate: (raw: unknown) => T | null,
): T | null {
  const raw = readFrom(area, key);
  if (raw === null) return null;
  try {
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Read a string from `localStorage`; `null` when absent or storage is unavailable. */
export function readStorage(key: string): string | null {
  return readFrom('localStorage', key);
}

/** Write a string to `localStorage`; failures (quota, private mode) are silent by design. */
export function writeStorage(key: string, value: string): void {
  writeTo('localStorage', key, value);
}

/** Remove a key from `localStorage`; failures are silent. */
export function removeStorage(key: string): void {
  removeFrom('localStorage', key);
}

/** Read JSON from `localStorage` through a validator; `null` when absent, unparsable or invalid. */
export function readStorageJson<T>(key: string, validate: (raw: unknown) => T | null): T | null {
  return readJsonFrom('localStorage', key, validate);
}

/** Write a JSON-serialisable value to `localStorage`. */
export function writeStorageJson(key: string, value: unknown): void {
  writeStorage(key, JSON.stringify(value));
}

/** Read a string from `sessionStorage` (this tab only); `null` when absent or storage is unavailable. */
export function readSessionStorage(key: string): string | null {
  return readFrom('sessionStorage', key);
}

/**
 * Write a string to `sessionStorage`. Never throws; returns `false` when the value was not stored
 * (blocked site data, quota), so a caller that depends on the value (the offline page's reload
 * guard, 04 §18.6.4) can tell an unusable storage from an empty one.
 */
export function writeSessionStorage(key: string, value: string): boolean {
  return writeTo('sessionStorage', key, value);
}

/** Remove a key from `sessionStorage`; failures are silent. */
export function removeSessionStorage(key: string): void {
  removeFrom('sessionStorage', key);
}

/** Read JSON from `sessionStorage` through a validator; `null` when absent, unparsable or invalid. */
export function readSessionStorageJson<T>(
  key: string,
  validate: (raw: unknown) => T | null,
): T | null {
  return readJsonFrom('sessionStorage', key, validate);
}

/** Write a JSON-serialisable value to `sessionStorage`; `false` when it was not stored. */
export function writeSessionStorageJson(key: string, value: unknown): boolean {
  return writeSessionStorage(key, JSON.stringify(value));
}

/** @module lib/storage — try/catch `localStorage` access for per-device conveniences (spec 04 §4.6) */

/** Read a string from `localStorage`; `null` when absent or storage is unavailable. */
export function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a string to `localStorage`; failures (quota, private mode) are silent by design. */
export function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort (spec 04 §4.6).
  }
}

/** Remove a key from `localStorage`; failures are silent. */
export function removeStorage(key: string): void {
  try {
    globalThis.localStorage.removeItem(key);
  } catch {
    // Persistence is best-effort (spec 04 §4.6).
  }
}

/** Read JSON from `localStorage` through a validator; `null` when absent, unparsable or invalid. */
export function readStorageJson<T>(key: string, validate: (raw: unknown) => T | null): T | null {
  const raw = readStorage(key);
  if (raw === null) return null;
  try {
    return validate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Write a JSON-serialisable value to `localStorage`. */
export function writeStorageJson(key: string, value: unknown): void {
  writeStorage(key, JSON.stringify(value));
}

/** @module infra/browsers/profile-origins — the web origins a template's profile holds site data for (spec 13 §2.3 **Remove sign-in**): read from Chromium's storage directories on disk, so data written by an earlier start of the browser is found too. Names and origins only, never values. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Storage directories of a profile whose files or entry names carry origins. */
const STORAGE_DIRS = [
  'Local Storage/leveldb',
  'Session Storage',
  'IndexedDB',
  'Service Worker/Database',
  'Service Worker/CacheStorage',
  'Shared Storage',
  'WebStorage',
] as const;

/** Files larger than this are not scanned (a cache body, not an index). */
const MAX_SCANNED_BYTES = 16 * 1024 * 1024;
/** Entries visited per directory tree at most. */
const MAX_ENTRIES = 5_000;

const ORIGIN = /https?:\/\/[a-z0-9.-]+(?::\d{1,5})?/gi;
/** `https_app.example.com_0.indexeddb.leveldb` → `https://app.example.com`. */
const IDB_DIR = /^(https?)_([a-z0-9.-]+)_(\d+)\.indexeddb\./i;

function originOfIdbDir(name: string): string | null {
  const m = IDB_DIR.exec(name);
  if (m === null) return null;
  const [, scheme, host, port] = m;
  const fallback = scheme === 'https' ? '443' : '80';
  return `${scheme}://${host}${port === '0' || port === fallback ? '' : `:${port}`}`;
}

async function scanTree(dir: string, found: Set<string>, budget: { left: number }): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (budget.left-- <= 0) return;
    const idb = originOfIdbDir(name);
    if (idb !== null) found.add(idb.toLowerCase());
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info === null) continue;
    if (info.isDirectory()) {
      await scanTree(path, found, budget);
      continue;
    }
    if (info.size > MAX_SCANNED_BYTES) continue;
    const text = await readFile(path, 'latin1').catch(() => '');
    for (const match of text.matchAll(ORIGIN)) found.add(match[0].toLowerCase());
  }
}

/** Every `http(s)` origin the profile under `userDataDir` (its `Default` profile) keeps site data for. */
export async function profileOrigins(userDataDir: string): Promise<Set<string>> {
  const found = new Set<string>();
  for (const dir of STORAGE_DIRS) {
    await scanTree(join(userDataDir, 'Default', dir), found, { left: MAX_ENTRIES });
  }
  return found;
}

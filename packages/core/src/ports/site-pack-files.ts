/** @module ports/site-pack-files — the files behind pack approval (spec 13 §9.6, §10.5, D-67): the approved-copy cache `<dataDir>/site-packs/cache/<source>/<pack id>/<sha256>.json` and the local folder `POST /site-packs/import` writes unsigned packs into. */

import type { SitePackSourceId } from './persistence/site-packs.ts';

/**
 * Byte-exact copies of every approved pack version, so a later release that drops or changes a
 * bundled version, or an edit of a local file, keeps the approved content in force (D-67).
 */
export interface SitePackCache {
  /** Stores `bytes` (idempotent: an existing copy of the same hash is kept). */
  put(source: SitePackSourceId, packId: string, sha256: string, bytes: Uint8Array): Promise<void>;
  /** The stored copy, or `null` when it is missing or unreadable. */
  get(source: SitePackSourceId, packId: string, sha256: string): Promise<Uint8Array | null>;
  /** Where a copy lives (reports). */
  pathOf(source: SitePackSourceId, packId: string, sha256: string): string;
}

/** The local folder (`sitePacksDir`) as `POST /site-packs/import` writes to it. */
export interface LocalPackWriter {
  /** The folder (`sitePacksDir`). */
  readonly dir: string;
  /** Writes `<dir>/<packId>.json` atomically; returns its path. */
  write(packId: string, bytes: Uint8Array): Promise<string>;
}

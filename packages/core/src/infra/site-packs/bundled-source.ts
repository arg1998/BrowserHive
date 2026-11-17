/** @module infra/site-packs/bundled-source — the packs shipped with this release (spec 13 §9.8, §10.9): `dist/site-packs/packs/*.json` with the build's `index.json` (sizes and hashes checked against it), or, running from source, `registry/packs/<id>.json` directly. A missing folder is an empty catalog. */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SITE_PACK_MAX_BYTES } from '@browserhive/contracts/site-packs';
import { z } from 'zod';
import { loadPackBytes } from '../../domain/site-packs/load.ts';
import { err, ok, type Result } from '../../kernel/result.ts';
import type {
  SitePackSource,
  SitePackSourceError,
  SkippedPackVersion,
  SourceCatalog,
  SourcePackVersion,
} from '../../ports/site-packs.ts';
import { isMissing, readBounded } from './pack-files.ts';

/** `dist/site-packs/index.json`, written by `packages/browserhive/scripts/bundle-site-packs.ts`. */
export const BundledIndex = z.object({
  release: z.string(),
  built_at: z.number().int().nullable(),
  packs: z.array(
    z.object({
      id: z.string(),
      version: z.number().int(),
      sha256: z.string(),
      size: z.number().int(),
      path: z.string().regex(/^packs\/[a-z0-9.-]+\.json$/),
    }),
  ),
});
/** The bundled index. */
export type BundledIndex = z.infer<typeof BundledIndex>;

/** Options of {@link BundledPackSource}. */
export interface BundledPackSourceOptions {
  /** `dist/site-packs` (with `index.json` and `packs/`) or `registry/packs`. */
  readonly dir: string;
  /** This release (`VERSION`): the provenance "Bundled with BrowserHive x.y.z". */
  readonly release: string;
  /** Checked against `min_client`/`max_client`; defaults to `release`. */
  readonly binaryVersion?: string;
}

/** The bundled snapshot. */
export class BundledPackSource implements SitePackSource {
  readonly id = 'bundled' as const;
  readonly trust = 'publisher' as const;
  readonly dir: string;
  readonly release: string;
  readonly #binaryVersion: string;
  #builtAt: number | null = null;

  constructor(options: BundledPackSourceOptions) {
    this.dir = options.dir;
    this.release = options.release;
    this.#binaryVersion = options.binaryVersion ?? options.release;
  }

  /** `built_at` of the build's index (`null` from source or before the first load). */
  get builtAt(): number | null {
    return this.#builtAt;
  }

  async load(_signal: AbortSignal): Promise<Result<SourceCatalog, SitePackSourceError>> {
    try {
      const index = await readBounded(join(this.dir, 'index.json'), 4 * 1024 * 1024);
      if (index.kind === 'bytes') return ok(await this.#fromIndex(index.bytes));
      if (index.kind === 'too_large') return this.#failed('index.json is too large');
      return ok(await this.#fromFolder());
    } catch (error) {
      return this.#failed(error instanceof Error ? error.message : String(error));
    }
  }

  #failed(message: string): Result<SourceCatalog, SitePackSourceError> {
    return err({ source: 'bundled', message: `${this.dir}: ${message}` });
  }

  /** `registry/packs/<id>.json` (a source run). */
  async #fromFolder(): Promise<SourceCatalog> {
    this.#builtAt = null;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isMissing(error)) return { source: 'bundled', packs: [], skipped: [], signedLayouts: 0 };
      throw error;
    }
    const packs: SourcePackVersion[] = [];
    const skipped: SkippedPackVersion[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const id = name.slice(0, -'.json'.length);
      this.#one(await readBounded(join(this.dir, name), SITE_PACK_MAX_BYTES), id, packs, skipped);
    }
    return { source: 'bundled', packs, skipped, signedLayouts: 0 };
  }

  /** `dist/site-packs/index.json` + `packs/*.json` (a build). */
  async #fromIndex(bytes: Uint8Array): Promise<SourceCatalog> {
    const parsed = BundledIndex.safeParse(parseJson(bytes));
    if (!parsed.success) throw new Error('index.json is not a bundled pack index');
    this.#builtAt = parsed.data.built_at;
    const packs: SourcePackVersion[] = [];
    const skipped: SkippedPackVersion[] = [];
    for (const entry of parsed.data.packs) {
      const read = await readBounded(join(this.dir, entry.path), SITE_PACK_MAX_BYTES);
      const before = packs.length;
      this.#one(read, entry.id, packs, skipped);
      const loaded = packs[before];
      if (loaded !== undefined && (loaded.sha256 !== entry.sha256 || loaded.size !== entry.size)) {
        packs.pop();
        skipped.push({
          packId: entry.id,
          version: entry.version,
          reason: 'invalid',
          detail: `${entry.path} does not match the hash or size in index.json`,
        });
      }
    }
    return { source: 'bundled', packs, skipped, signedLayouts: 0 };
  }

  #one(
    read: Awaited<ReturnType<typeof readBounded>>,
    id: string,
    packs: SourcePackVersion[],
    skipped: SkippedPackVersion[],
  ): void {
    if (read.kind === 'missing') {
      skipped.push({ packId: id, version: null, reason: 'not_found', detail: 'file missing' });
      return;
    }
    if (read.kind === 'too_large') {
      skipped.push({
        packId: id,
        version: null,
        reason: 'too_large',
        detail: `${read.size} bytes; a pack is at most ${SITE_PACK_MAX_BYTES}`,
      });
      return;
    }
    const loaded = loadPackBytes(read.bytes, {
      origin: this.release,
      binaryVersion: this.#binaryVersion,
      expectedId: id,
    });
    if (loaded.ok) packs.push(loaded.value);
    else skipped.push(loaded.error);
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

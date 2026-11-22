/** @module infra/site-packs/local-source — the local folder (`sitePacksDir`, spec 13 §10.5): unsigned single-pack files `<pack id>.json` written by the local administrator, validated like any pack and applied only after an operator approves their content. Signed layouts (`keys.json`/`index.json` at the top, or one per subfolder) are listed for the registry client, which verifies them like an import (T4b). A missing folder is an empty catalog. */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SITE_PACK_MAX_BYTES } from '@browserhive/contracts/site-packs';
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

/** Top-level files that mark a signed layout. */
const LAYOUT_FILES: ReadonlySet<string> = new Set([
  'keys.json',
  'keys.json.sig',
  'index.json',
  'index.json.sig',
]);

/** Options of {@link LocalPackSource}. */
export interface LocalPackSourceOptions {
  readonly dir: string;
  /** Checked against `min_client`/`max_client`. */
  readonly binaryVersion: string;
}

/** Unsigned local packs. */
export class LocalPackSource implements SitePackSource {
  readonly id = 'local' as const;
  readonly trust = 'operator' as const;
  readonly dir: string;
  readonly #binaryVersion: string;

  constructor(options: LocalPackSourceOptions) {
    this.dir = options.dir;
    this.#binaryVersion = options.binaryVersion;
  }

  async load(_signal: AbortSignal): Promise<Result<SourceCatalog, SitePackSourceError>> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).sort();
    } catch (error) {
      if (isMissing(error))
        return ok({ source: 'local', packs: [], skipped: [], signedLayouts: 0, layouts: [] });
      return err({ source: 'local', message: `${this.dir}: ${messageOf(error)}` });
    }
    const packs: SourcePackVersion[] = [];
    const skipped: SkippedPackVersion[] = [];
    const layouts: string[] = [];
    const topLayout = names.some((n) => LAYOUT_FILES.has(n));
    if (topLayout) layouts.push(this.dir);
    for (const name of names) {
      if (name.startsWith('.') || LAYOUT_FILES.has(name)) continue;
      const path = join(this.dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        // `packs/` belongs to the top-level layout; any other folder is a layout of its own.
        if (!(topLayout && name === 'packs')) layouts.push(path);
        continue;
      }
      if (!info.isFile() || !name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        this.#one(await readBounded(path, SITE_PACK_MAX_BYTES), id, path, packs, skipped);
      } catch (error) {
        skipped.push({ packId: id, version: null, reason: 'unreadable', detail: messageOf(error) });
      }
    }
    return ok({ source: 'local', packs, skipped, signedLayouts: layouts.length, layouts });
  }

  #one(
    read: Awaited<ReturnType<typeof readBounded>>,
    id: string,
    path: string,
    packs: SourcePackVersion[],
    skipped: SkippedPackVersion[],
  ): void {
    if (read.kind === 'missing') return;
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
      origin: path,
      binaryVersion: this.#binaryVersion,
      expectedId: id,
    });
    if (loaded.ok) packs.push(loaded.value);
    else skipped.push(loaded.error);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

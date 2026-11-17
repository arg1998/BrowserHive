/** @module cli/commands/sitepacks-local — `browserhive sitepacks reload` and `sitepacks import <file>`: the local folder over a running server's REST API. An import sends the file's text unchanged, so the SHA-256 the server stores and asks to approve is the file's own (the one `sitepacks verify` prints) (spec 13 §10.5, §11.5) */
import { basename } from 'node:path';
import {
  SITE_PACK_IMPORT_MAX_BYTES,
  SitePackImportResponse,
  SitePackReloadResponse,
} from '@browserhive/contracts/http';
import { sha256Hex } from '@browserhive/core/server';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type SitePacksAction } from '../invocation.ts';
import { size } from './common.ts';
import { type SitePacksTarget, sitePackCall, unexpected } from './sitepacks-common.ts';

type Of<K extends SitePacksAction['kind']> = Extract<SitePacksAction, { readonly kind: K }>;

/**
 * `sitepacks reload`: reads the bundled packs and the local folder again.
 *
 * @returns 0, or 1 on a failure.
 */
export async function runSitePacksReload(
  context: CommandContext,
  target: SitePacksTarget,
): Promise<ExitCode> {
  const { out } = context;
  const result = await sitePackCall(context, target.remote, 'POST', '/site-packs/reload', {});
  if (!result.ok) return result.code;
  const parsed = SitePackReloadResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'reload result');
  if (target.json) {
    out.json(parsed.data);
    return EXIT.ok;
  }
  for (const source of parsed.data.stats.sources) {
    const skipped = source.skipped.length;
    out.status(
      skipped === 0 ? 'ok' : 'warn',
      `${source.source}: ${source.loaded} loaded`,
      skipped === 0 ? undefined : `${skipped} skipped`,
    );
    for (const s of source.skipped) {
      const version = s.version === null ? '' : ` v${s.version}`;
      out.line(`  ${out.style.dim(`${s.pack_id}${version}:`)} ${s.reason} ${s.detail}`);
    }
  }
  return EXIT.ok;
}

/** Files of a signed layout (spec 13 §10.1). */
function isSignedLayoutFile(path: string): boolean {
  const name = basename(path);
  return name === 'keys.json' || name === 'index.json' || name.endsWith('.sig');
}

/**
 * `sitepacks import <file>`: sends one unsigned pack file's text, byte for byte; the server stores
 * it in the local folder, where it waits for approval. Signed layouts are refused here (a later release).
 *
 * @returns 0, or 1 on a failure.
 */
export async function runSitePacksImport(
  context: CommandContext,
  target: SitePacksTarget,
  action: Of<'import'>,
): Promise<ExitCode> {
  const { out, deps } = context;
  const { path } = action;
  const refuse = (why: string): ExitCode => {
    out.diagnostic(`browserhive: ${path} ${why}`);
    return EXIT.fatal;
  };
  const info = await deps.fs.stat(path);
  if (info === null) return refuse('does not exist.');
  if (info.isDirectory || isSignedLayoutFile(path)) {
    return refuse(
      'looks like a signed layout (keys.json, index.json, packs/). Signed layouts arrive with a later release; import one pack file (<pack id>.json) instead.',
    );
  }
  if (!info.isFile) return refuse('is not a file.');
  if (info.sizeBytes > SITE_PACK_IMPORT_MAX_BYTES) {
    return refuse(
      `is ${size(info.sizeBytes)}; an import may be at most ${size(SITE_PACK_IMPORT_MAX_BYTES)}.`,
    );
  }
  const text = await deps.fs.readFile(path);
  try {
    JSON.parse(text);
  } catch {
    return refuse('is not JSON. Expected one site pack (schema 1).');
  }
  // The file's text as it is: the server validates, hashes and stores exactly these bytes.
  const fileSha256 = sha256Hex(new TextEncoder().encode(text));
  const result = await sitePackCall(context, target.remote, 'POST', '/site-packs/import', { text });
  if (!result.ok) return result.code;
  const parsed = SitePackImportResponse.safeParse(result.json);
  if (!parsed.success) return unexpected(context, 'import result');
  if (target.json) {
    out.json(parsed.data);
    return EXIT.ok;
  }
  for (const item of parsed.data.imported) {
    const state = item.state === 'approved' ? 'approved' : 'waiting for approval';
    out.status('ok', `imported ${item.pack_id} v${item.version} into the local folder`, state);
    out.line(`  SHA-256 ${item.sha256}`);
    if (item.sha256 !== fileSha256) {
      out.status('warn', `the stored content differs from ${path}`, `file SHA-256 ${fileSha256}`);
    }
    if (item.state !== 'approved') {
      out.line(`  Review and approve it: browserhive sitepacks approve-local ${item.pack_id}`);
    }
  }
  return EXIT.ok;
}

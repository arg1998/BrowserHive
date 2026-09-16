/** @module infra/static/directory-assets — a directory-backed asset index (dashboard bundle, trace viewer) with lazy, cached reads. */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { StaticAsset, StaticAssets, TraceViewerAssets } from '../../ports/static-assets.ts';

/** Content types by extension. */
export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function walk(root: string, dir: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, abs, out);
    else if (entry.isFile()) out.set(relative(root, abs).split(sep).join('/'), abs);
  }
}

function toArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

/** Options of {@link createDirectoryAssets}. */
export interface DirectoryAssetsOptions {
  /** Published paths under this prefix are content-hashed (cached immutable). */
  readonly immutablePrefix?: string;
}

/**
 * Indexes `dir` once (file names only) and serves files lazily with a per-path cache. A missing
 * directory yields an unavailable provider. `.gz`/`.br` siblings are served as encodings.
 */
export function createDirectoryAssets(
  dir: string | undefined,
  options: DirectoryAssetsOptions = {},
): StaticAssets & TraceViewerAssets {
  const index = new Map<string, string>();
  if (dir !== undefined) {
    try {
      if (statSync(dir).isDirectory()) walk(dir, dir, index);
    } catch {
      index.clear();
    }
  }
  const cache = new Map<string, StaticAsset>();
  const load = (path: string): StaticAsset | null => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const abs = index.get(path);
    if (abs === undefined || path.endsWith('.gz') || path.endsWith('.br')) return null;
    const bytes = toArrayBuffer(readFileSync(abs));
    const gz = index.get(`${path}.gz`);
    const br = index.get(`${path}.br`);
    const asset: StaticAsset = {
      path,
      contentType: MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      bytes,
      etag: `"${createHash('sha1').update(bytes).digest('base64url')}"`,
      immutable: options.immutablePrefix !== undefined && path.startsWith(options.immutablePrefix),
      ...((gz !== undefined || br !== undefined) && {
        encodings: {
          ...(gz !== undefined && { gzip: toArrayBuffer(readFileSync(gz)) }),
          ...(br !== undefined && { br: toArrayBuffer(readFileSync(br)) }),
        },
      }),
    };
    cache.set(path, asset);
    return asset;
  };
  return {
    available: index.has('index.html'),
    async indexHtml() {
      const asset = load('index.html');
      return asset === null ? null : new TextDecoder().decode(asset.bytes);
    },
    async get(path) {
      return load(path);
    },
  };
}

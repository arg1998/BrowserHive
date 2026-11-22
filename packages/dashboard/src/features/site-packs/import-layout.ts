/** @module features/site-packs/import-layout — a signed folder chosen in the browser as the `{files, name}` body of `POST /site-packs/import` (spec 13 §10.5): the folder holding `keys.json` is the layout's root (a picked folder may hold it one level down), hidden files are left out, a pack file picked without its folder (`<sha256>.json`) goes under `packs/<its id>/`; base64 of each file's exact bytes; the 1 MiB body and 512-file limits are checked before sending */
import {
  SITE_PACK_IMPORT_MAX_BYTES,
  SITE_PACK_IMPORT_MAX_FILES,
} from '@browserhive/contracts/http';
import { LOOSE_FILES } from './registry-model.ts';

/** The top-level files of a signed layout (spec 13 §10.1). */
export const LAYOUT_ROOT_FILES = ['keys.json', 'keys.json.sig', 'index.json', 'index.json.sig'];

/** A picked file: its bytes and where it sat in the picked folder (`''` when picked alone). */
export interface PickedFile {
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  readonly bytes: () => Promise<Uint8Array>;
}

/** The body to send, or why the folder can't be sent. */
export type LayoutBody =
  | {
      readonly ok: true;
      readonly files: Readonly<Record<string, string>>;
      readonly name: string;
      readonly count: number;
    }
  | { readonly ok: false; readonly problem: string };

/** A browser `File` as a picked file. */
export function pickedFile(file: File): PickedFile {
  return {
    name: file.name,
    relativePath: file.webkitRelativePath,
    size: file.size,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

/** Base64 of bytes (chunked, so large files don't overflow the argument list). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The pack id inside a pack file's JSON, or `null`. */
function packIdOf(bytes: Uint8Array): string | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const id: unknown = Reflect.get(parsed, 'id');
    return typeof id === 'string' && /^[a-z0-9.-]{1,253}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** `true` when the picked files look like a signed layout (they include `keys.json`). */
export function isLayout(files: readonly PickedFile[]): boolean {
  return files.some((f) => f.name === 'keys.json');
}

/** The body of a signed folder's import. */
export async function layoutBody(files: readonly PickedFile[]): Promise<LayoutBody> {
  const segmentsOf = (f: PickedFile) =>
    (f.relativePath === '' ? f.name : f.relativePath).split('/').filter((s) => s !== '');
  const keys = files
    .filter((f) => f.name === 'keys.json')
    .map(segmentsOf)
    .sort((a, b) => a.length - b.length)[0];
  if (keys === undefined)
    return {
      ok: false,
      problem:
        'The folder has no keys.json. Choose the folder an export wrote: keys.json, index.json, their .sig files and packs/.',
    };
  const root = keys.slice(0, -1);
  // The folder that holds keys.json names the import; files picked without a folder have none.
  const name = root.at(-1) ?? LOOSE_FILES;
  const out: Record<string, string> = {};
  let total = 0;
  for (const file of files) {
    const segments = segmentsOf(file);
    if (segments.some((s) => s.startsWith('.'))) continue;
    if (!root.every((s, i) => segments[i] === s)) continue;
    const inner = segments.slice(root.length);
    const bytes = await file.bytes();
    let path = inner.join('/');
    // A pack file picked on its own (no folder): place it where the layout keeps it.
    if (
      inner.length === 1 &&
      !LAYOUT_ROOT_FILES.includes(path) &&
      /^[0-9a-f]{64}\.json$/.test(path)
    ) {
      const id = packIdOf(bytes);
      if (id !== null) path = `packs/${id}/${path}`;
    }
    const encoded = toBase64(bytes);
    total += encoded.length + path.length + 8;
    out[path] = encoded;
  }
  const count = Object.keys(out).length;
  if (count > SITE_PACK_IMPORT_MAX_FILES)
    return {
      ok: false,
      problem: `The folder holds ${count} files; an import takes at most ${SITE_PACK_IMPORT_MAX_FILES}.`,
    };
  if (total > SITE_PACK_IMPORT_MAX_BYTES)
    return {
      ok: false,
      problem:
        'The folder is larger than 1 MiB once encoded. Import it with browserhive sitepacks import <dir> instead.',
    };
  return { ok: true, files: out, name, count };
}

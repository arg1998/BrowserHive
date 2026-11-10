/** @module infra/fs/template-key — resolving the template key once per process (spec 13 §2.4): `templateKey` from the configuration, else `<data-dir>/admin/template.key`, created with `O_CREAT | O_EXCL` and mode 0600 only while no encrypted template file exists, never re-created over existing files. */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { KEY_BYTES, type TemplateKey, templateKeyOf } from '../../domain/templates/envelope.ts';

/** `<data-dir>/admin/template.key`. */
export function templateKeyPath(dataDir: string): string {
  return join(dataDir, 'admin', 'template.key');
}

/** Where the current key came from. */
export type TemplateKeySource =
  /** `templateKey` (environment, reference or flag). */
  | 'config'
  /** The key file, already present. */
  | 'file'
  /** The key file, created by this call. */
  | 'created'
  /** No key: files exist and nothing resolves (`TEMPLATE_KEY_MISSING`), or the file is unreadable. */
  | 'none';

/** What {@link resolveTemplateKeys} found. */
export interface ResolvedTemplateKeys {
  readonly current: TemplateKey | null;
  readonly previous: TemplateKey | null;
  readonly source: TemplateKeySource;
  /** The key file's path (whether or not it is used). */
  readonly path: string;
  /** Why the key file was not used, when it exists but cannot be read as a key. */
  readonly problem: string | null;
}

/** Inputs of {@link resolveTemplateKeys}. */
export interface ResolveTemplateKeysInput {
  readonly dataDir: string;
  /** `templateKey`: base64 of 32 bytes (validated by the config parser). */
  readonly configured?: string | undefined;
  /** `templateKeyPrevious`. */
  readonly previous?: string | undefined;
  /** Whether any checkpoint or version file exists in any template (no key is created then). */
  readonly filesExist: () => Promise<boolean>;
}

/** 32 bytes from base64 (standard or URL-safe), or `null`. */
export function decodeTemplateKey(text: string): Uint8Array | null {
  const normal = text.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(normal)) return null;
  const bytes = Buffer.from(normal, 'base64');
  return bytes.length === KEY_BYTES ? new Uint8Array(bytes) : null;
}

function keyOrNull(text: string | undefined): TemplateKey | null {
  if (text === undefined) return null;
  const bytes = decodeTemplateKey(text);
  return bytes === null ? null : templateKeyOf(bytes);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Reads the key file; `problem` when it exists but is not a key. */
export async function readKeyFile(
  path: string,
): Promise<{ readonly key: TemplateKey | null; readonly problem: string | null } | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { key: null, problem: `cannot read ${path}: ${(err as Error).message}` };
  }
  const key = keyOrNull(text);
  return key === null
    ? { key: null, problem: `${path} does not hold base64 of 32 bytes` }
    : { key, problem: null };
}

/**
 * Creates the key file exclusively (`O_CREAT | O_EXCL`, mode 0600) in `admin/` (0700). Returns the
 * key, or `null` when another process created the file first (`EEXIST`): the caller reads it.
 */
export async function createKeyFile(path: string, dir: string): Promise<TemplateKey | null> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const bytes = new Uint8Array(randomBytes(KEY_BYTES));
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  }
  try {
    await handle.writeFile(`${Buffer.from(bytes).toString('base64')}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return templateKeyOf(bytes);
}

/**
 * Resolves the keys once per process (spec 13 §2.4). `templateKey` wins; otherwise the key file is
 * read, or created when it is absent and no encrypted file exists anywhere. When files exist and
 * nothing resolves, `current` is `null`: the caller records `TEMPLATE_KEY_MISSING`, skips
 * checkpoints and versions and refuses restores, and the hosts keep running.
 */
export async function resolveTemplateKeys(
  input: ResolveTemplateKeysInput,
): Promise<ResolvedTemplateKeys> {
  const path = templateKeyPath(input.dataDir);
  const previous = keyOrNull(input.previous);
  const configured = keyOrNull(input.configured);
  if (configured !== null) {
    return { current: configured, previous, source: 'config', path, problem: null };
  }
  const found = await readKeyFile(path);
  if (found !== null) {
    return {
      current: found.key,
      previous,
      source: found.key === null ? 'none' : 'file',
      path,
      problem: found.problem,
    };
  }
  if (await input.filesExist()) {
    return { current: null, previous, source: 'none', path, problem: null };
  }
  const created = await createKeyFile(path, join(input.dataDir, 'admin'));
  if (created !== null)
    return { current: created, previous, source: 'created', path, problem: null };
  // Another process won the race: use its key.
  const raced = await readKeyFile(path);
  const key = raced?.key ?? null;
  return {
    current: key,
    previous,
    source: key === null ? 'none' : 'file',
    path,
    problem: raced?.problem ?? null,
  };
}

/** Whether the key file exists (doctor, purge inventories). */
export function keyFileExists(dataDir: string): Promise<boolean> {
  return exists(templateKeyPath(dataDir));
}

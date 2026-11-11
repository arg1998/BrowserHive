/** @module infra/fs/template-key — resolving the template key once per process (spec 13 §2.4): `templateKey` from the configuration, else `<data-dir>/admin/template.key`, created exclusively (`O_EXCL` temporary file, then an exclusive hard link) with mode 0600 only while no encrypted template file exists, never re-created over existing files. */

import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
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
  /** Test seam: the file operations key creation uses. */
  readonly fileOps?: KeyFileOps;
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

/** How often, and how long apart, a reader retries a key file that is still being written. */
const PARTIAL_RETRIES = 10;
const PARTIAL_RETRY_MS = 20;

/**
 * Reads the key file; `problem` when it exists but is not a key. A short file (a writer without
 * hard links is still writing it) is read again a few times before it counts as a problem.
 */
export async function readKeyFile(
  path: string,
): Promise<{ readonly key: TemplateKey | null; readonly problem: string | null } | null> {
  for (let attempt = 0; ; attempt++) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return { key: null, problem: `cannot read ${path}: ${(err as Error).message}` };
    }
    const key = keyOrNull(text);
    if (key !== null) return { key, problem: null };
    if (text.trim().length >= 43 || attempt >= PARTIAL_RETRIES) {
      return { key: null, problem: `${path} does not hold base64 of 32 bytes` };
    }
    await new Promise((resolve) => setTimeout(resolve, PARTIAL_RETRY_MS));
  }
}

/** `link()` errors of filesystems without hard links (exFAT, vboxsf, some SMB and FUSE mounts). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK']);

/** The file operations key creation uses (a test seam for filesystems without hard links). */
export interface KeyFileOps {
  link(existing: string, target: string): Promise<void>;
}

const NODE_KEY_FILE_OPS: KeyFileOps = { link };

/** Writes `text` to a new file (`O_CREAT | O_EXCL`, 0600) and `fsync`s it; `false` on `EEXIST`. */
async function writeExclusive(path: string, text: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Creates the key file exclusively with its content in place: the key is written to a private
 * temporary file (`O_CREAT | O_EXCL`, mode 0600, `fsync`) in `admin/` (0700), which is then
 * hard-linked to the key file's name. The link fails with `EEXIST` when another process created
 * the key first, so the name never exists half-written and two processes never both win. Where the
 * filesystem has no hard links the key file is created directly with `O_CREAT | O_EXCL` (readers
 * retry a short file). Returns the key, or `null` when another process won (the caller reads it).
 */
export async function createKeyFile(
  path: string,
  dir: string,
  ops: KeyFileOps = NODE_KEY_FILE_OPS,
): Promise<TemplateKey | null> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const bytes = new Uint8Array(randomBytes(KEY_BYTES));
  const text = `${Buffer.from(bytes).toString('base64')}\n`;
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeExclusive(tmp, text);
    try {
      await ops.link(tmp, path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return null;
      if (!NO_HARD_LINKS.has(code)) throw err;
      if (!(await writeExclusive(path, text))) return null;
    }
    return templateKeyOf(bytes);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Removes `template.key.*.tmp` left by a crash during creation (a second copy of a key). */
async function removeKeyTemporaries(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^template\.key\.[0-9a-f]+\.tmp$/.test(name)) {
      await rm(join(dir, name), { force: true }).catch(() => undefined);
    }
  }
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
  await removeKeyTemporaries(join(input.dataDir, 'admin'));
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
  let created: TemplateKey | null;
  try {
    created = await createKeyFile(path, join(input.dataDir, 'admin'), input.fileOps);
  } catch (err) {
    // Never fatal: templates run without checkpoints until the key file can be created.
    return {
      current: null,
      previous,
      source: 'none',
      path,
      problem: `cannot create ${path}: ${(err as Error).message}`,
    };
  }
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

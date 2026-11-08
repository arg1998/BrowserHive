/** @module app/auth-states/zip — directory ⇄ zip file for full-profile snapshots: streamed in bounded slices (native zlib raw deflate inside fflate's `Zip` container), regular files only, regenerable caches excluded, atomic write, CRC-checked extract with the zip-slip guard (D-24). */

import { randomBytes } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { crc32, createDeflateRaw, createInflateRaw } from 'node:zlib';
import { Zip, type ZipInputFile } from 'fflate';
import { AppError } from '../../kernel/errors/app-error.ts';
import { resolveZipEntry } from '../../kernel/paths.ts';

/** One directory entry as the zip helpers see it. */
export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/** An open file read in slices (production: a `node:fs/promises` `FileHandle`). */
export interface ZipReadHandle {
  /** Reads up to `buffer.length` bytes from `position`; resolves the count read (`0` at end of file). */
  read(buffer: Uint8Array, position: number): Promise<number>;
  /** Current size of the file in bytes. */
  size(): Promise<number>;
  close(): Promise<void>;
}

/** An open file written in slices (production: a `node:fs/promises` `FileHandle`). */
export interface ZipWriteHandle {
  /** Appends all of `data`. */
  write(data: Uint8Array): Promise<void>;
  /** Flushes the file to stable storage (`fsync`). */
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The filesystem slice the zip helpers need (production: `node:fs/promises`, see {@link createNodeZipFs}). */
export interface ZipFs {
  readdir(dir: string): Promise<readonly DirEntry[]>;
  /** Recursive mkdir (`mkdir -p`). */
  mkdir(dir: string): Promise<void>;
  openRead(path: string): Promise<ZipReadHandle>;
  /** Creates or truncates `path` with `mode` (owner-only for anything holding a login). */
  openWrite(path: string, mode: number): Promise<ZipWriteHandle>;
  /**
   * Creates a uniquely named sibling of `path` (`<path>.<random>.tmp`, `mode`) for an atomic
   * write, so two saves of the same name never share a temp file.
   */
  createTemp(
    path: string,
    mode: number,
  ): Promise<{ readonly path: string; readonly handle: ZipWriteHandle }>;
  /** Atomically replaces `to` with `from`. */
  rename(from: string, to: string): Promise<void>;
  /** Removes a file; a missing file is not an error. */
  remove(path: string): Promise<void>;
}

/** Compression level for profile zips (`6`: profiles compress well; a balance of speed and size). */
export const ZIP_LEVEL = 6;

/** Mode of the archive and of every restored file: both hold live cookies and tokens. */
const SECRET_FILE_MODE = 0o600;

/** Bytes read from a profile file per slice: the stream's unit of memory and of work between yields. */
const SAVE_CHUNK_BYTES = 128 * 1024;

/** Compressed bytes read from the archive per slice on restore. */
const RESTORE_CHUNK_BYTES = 64 * 1024;

/**
 * Zip without its 64-bit extension (which fflate does not write) stores sizes and offsets in 32
 * bits. A larger archive or member would be silently corrupt, so it is refused instead.
 */
const ZIP32_LIMIT = 0xffff_ffff;

/**
 * Regenerable Chromium caches, as directory paths matched at any depth of the profile (`Cache`
 * matches `Default/Cache` and `Profile 1/Cache`). Checked against Playwright 1.63's Chromium
 * profile, headed and headless. They hold HTTP, compiled-code, shader and Cache API data, are
 * rebuilt on demand, and make up most of a used profile. Login data never lives in them: cookies
 * (`Cookies`, `Network/`), `Local Storage`, `IndexedDB`, `Session Storage`, `Login Data`,
 * `Preferences` and the service-worker registrations (`Service Worker/Database`) are all kept.
 */
export const PROFILE_CACHE_DIRS: readonly string[] = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'component_crx_cache',
  'Service Worker/CacheStorage',
  'Service Worker/ScriptCache',
];

const CACHE_DIR_SEGMENTS: readonly (readonly string[])[] = PROFILE_CACHE_DIRS.map((p) =>
  p.split('/'),
);

/** True when the directory at relative `segments` ends with one of {@link PROFILE_CACHE_DIRS}. */
function isCacheDir(segments: readonly string[]): boolean {
  return CACHE_DIR_SEGMENTS.some(
    (pattern) =>
      pattern.length <= segments.length &&
      pattern.every((part, i) => segments[segments.length - pattern.length + i] === part),
  );
}

/**
 * Recursively collects regular files under `root` as POSIX-style relative path → absolute path,
 * without descending into {@link PROFILE_CACHE_DIRS}. Symlinks, sockets and FIFOs are skipped: a
 * live Chromium profile contains `SingletonSocket` and `SingletonLock` which cannot — and must
 * not — be archived; a fresh profile recreates them.
 */
async function collectRegularFiles(root: string, fs: ZipFs): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, segments: readonly string[]): Promise<void> {
    for (const entry of await fs.readdir(dir)) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory) {
        const next = [...segments, entry.name];
        if (!isCacheDir(next)) await walk(abs, next);
      } else if (entry.isFile) out.set(relative(root, abs).split(sep).join('/'), abs);
    }
  }
  await walk(root, []);
  return out;
}

/**
 * Lock-marker files of a live profile: LevelDB's `LOCK` (Local Storage, IndexedDB, …) and the
 * profile's own `lockfile`. Empty, recreated by every launch, and on Windows held open exclusively
 * by the running browser, so a live snapshot cannot read them.
 */
export const PROFILE_LOCK_FILES: ReadonlySet<string> = new Set(['LOCK', 'lockfile']);

/** Codes of a file another process holds open exclusively (Windows sharing violations). */
const LOCKED_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** True when a read failure means "leave this file out" rather than "the snapshot failed". */
function skippable(rel: string, error: unknown): boolean {
  const code = codeOf(error);
  // A live browser deletes temp and journal files all the time: listed, then gone before the read.
  if (code === 'ENOENT') return true;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return code !== undefined && LOCKED_CODES.has(code) && PROFILE_LOCK_FILES.has(base);
}

/** The error for a read failure that is not {@link skippable}. */
function readFailure(rel: string, error: unknown): unknown {
  // A data file the running browser holds exclusively (Windows: cookies, history). Leaving it out
  // would be a silently incomplete snapshot; say which file and what to use instead.
  if (LOCKED_CODES.has(codeOf(error) ?? '')) {
    return new AppError('PROFILE_FILE_LOCKED', { file: rel }, { cause: error });
  }
  return error;
}

/**
 * Lets timers, sockets and other requests run between two slices. A macrotask on purpose: awaiting
 * an already-settled promise is a microtask and yields nothing.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Collects the `Zip` container's synchronous output between two awaits, and its first error. */
class ChunkSink {
  private chunks: Uint8Array[] = [];
  private failure: Error | null = null;

  /** fflate `ondata`-style callback. */
  readonly push = (err: Error | null, data: Uint8Array | null): void => {
    if (err !== null) this.failure ??= err;
    else if (data !== null && data.length > 0) this.chunks.push(data);
  };

  /** Hands back what was collected and resets; throws a reported error instead. */
  take(): Uint8Array[] {
    if (this.failure !== null) throw this.failure;
    const out = this.chunks;
    this.chunks = [];
    return out;
  }
}

/** Fills `buffer` from `position`, failing at end of file; resolves `buffer`. */
async function readFully(
  handle: ZipReadHandle,
  buffer: Uint8Array,
  position: number,
): Promise<Uint8Array> {
  let filled = 0;
  while (filled < buffer.length) {
    const n = await handle.read(buffer.subarray(filled), position + filled);
    if (n === 0) throw corrupt('unexpected end of file');
    filled += n;
  }
  return buffer;
}

/** An open profile file and its first slice, ready to become an archive entry. */
interface OpenedFile {
  readonly handle: ZipReadHandle;
  readonly first: Uint8Array;
}

/** Opens a file and reads its first slice; `null` when the file is to be left out ({@link skippable}). */
async function openForArchive(rel: string, abs: string, fs: ZipFs): Promise<OpenedFile | null> {
  let handle: ZipReadHandle;
  try {
    handle = await fs.openRead(abs);
  } catch (error) {
    if (skippable(rel, error)) return null;
    throw readFailure(rel, error);
  }
  try {
    // Read before the entry exists: Windows may refuse the read of a locked range after a
    // successful open, and the file must still be skippable then.
    const buffer = new Uint8Array(SAVE_CHUNK_BYTES);
    return { handle, first: buffer.subarray(0, await handle.read(buffer, 0)) };
  } catch (error) {
    await handle.close();
    if (skippable(rel, error)) return null;
    throw readFailure(rel, error);
  }
}

/**
 * An archive member whose bytes come from native zlib. fflate's `Zip` writes the local header,
 * the data descriptor (from `crc` and `size`, set before the final chunk) and the central
 * directory; it compresses nothing itself.
 */
function deflatedEntry(filename: string): ZipInputFile {
  return { filename, crc: 0, size: 0, compression: METHOD_DEFLATE };
}

/**
 * Deflates one opened file into `zip`, slice by slice, flushing the archive after each.
 *
 * Native zlib, not fflate's `ZipDeflate`: fflate 0.8.3's streaming `Deflate` emits invalid streams
 * for sparse input at level ≥ 4 (40 zero bytes with one `0x69` at offset 12 already fails, and a
 * Chromium `History-journal` did). Its async variant needs a Web Worker, broken under Bun. zlib's
 * stream runs off the main thread and is several times faster.
 */
async function addFile(
  zip: Zip,
  rel: string,
  file: OpenedFile,
  flush: () => Promise<void>,
): Promise<void> {
  const entry = deflatedEntry(rel);
  zip.add(entry);
  const emit = (data: Uint8Array<ArrayBuffer>, final: boolean): void => {
    // `Zip.add` installs `ondata`; its absence would be an fflate contract change.
    if (entry.ondata === undefined) throw new Error('zip entry was not added');
    entry.ondata(null, data, final);
  };
  async function* slices(): AsyncGenerator<Uint8Array> {
    let chunk = file.first;
    let crc = 0;
    let size = 0;
    while (chunk.length > 0) {
      size += chunk.length;
      if (size > ZIP32_LIMIT) throw new Error('profile file exceeds the 4 GiB zip limit');
      crc = crc32(chunk, crc);
      yield chunk;
      await yieldToEventLoop();
      // A fresh buffer per slice: zlib may still hold the previous one.
      const buffer = new Uint8Array(SAVE_CHUNK_BYTES);
      try {
        chunk = buffer.subarray(0, await file.handle.read(buffer, size));
      } catch (error) {
        // The entry is already in the archive; a failure past the first slice cannot be skipped.
        throw readFailure(rel, error);
      }
    }
    entry.crc = crc;
    entry.size = size;
  }
  await pipeline(
    slices(),
    createDeflateRaw({ level: ZIP_LEVEL }),
    async (compressed: AsyncIterable<Uint8Array>) => {
      for await (const data of compressed) {
        // zlib hands out pooled `Buffer`s; fflate takes a plain `Uint8Array` of its own.
        emit(new Uint8Array(data), false);
        await flush();
      }
    },
  );
  emit(new Uint8Array(0), true);
  await flush();
}

/**
 * Zips every regular file under `root` into the file `destPath` and returns the archive's size in
 * bytes. Streamed: each file is read, deflated (native zlib, off the main thread) and written in
 * bounded slices with a yield to the event loop between them, so memory stays flat and every other
 * session keeps running.
 *
 * The archive is written to a temp sibling (0600), fsynced and renamed over `destPath`: a failure
 * leaves no partial archive and an existing snapshot untouched.
 *
 * A snapshot never misses login data; regenerable caches ({@link PROFILE_CACHE_DIRS}) are excluded
 * by design. A live profile is a moving target, so two read failures leave the file out instead of
 * failing: a file that vanished after the listing, and a lock marker ({@link PROFILE_LOCK_FILES})
 * the running browser holds exclusively. A locked data file is `PROFILE_FILE_LOCKED` and anything
 * else is rethrown.
 *
 * @throws `PROFILE_FILE_LOCKED` `{ file }` for a data file the running browser holds exclusively.
 */
export async function zipDirectoryToFile(
  root: string,
  destPath: string,
  fs: ZipFs,
): Promise<number> {
  const files = await collectRegularFiles(root, fs);
  const temp = await fs.createTemp(destPath, SECRET_FILE_MODE);
  const sink = new ChunkSink();
  const zip = new Zip(sink.push);
  let written = 0;
  const flush = async (): Promise<void> => {
    for (const chunk of sink.take()) {
      written += chunk.length;
      if (written > ZIP32_LIMIT) throw new Error('profile archive exceeds the 4 GiB zip limit');
      await temp.handle.write(chunk);
    }
  };
  let committed = false;
  try {
    try {
      for (const [rel, abs] of files) {
        const file = await openForArchive(rel, abs, fs);
        if (file === null) continue;
        try {
          await addFile(zip, rel, file, flush);
        } finally {
          await file.handle.close();
        }
      }
      zip.end();
      await flush();
      await temp.handle.sync();
    } finally {
      await temp.handle.close();
    }
    await fs.rename(temp.path, destPath);
    committed = true;
    return written;
  } finally {
    if (!committed) {
      zip.terminate();
      await fs.remove(temp.path);
    }
  }
}

/** One member of an archive, as its central directory describes it. */
interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x0605_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const LOCAL_SIGNATURE = 0x0403_4b50;
const EOCD_MIN_BYTES = 22;
/** End-of-central-directory record plus the longest comment it may carry. */
const EOCD_MAX_BYTES = EOCD_MIN_BYTES + 0xffff;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** General-purpose flag bit 11: the name is UTF-8 (otherwise CP437, read as Latin-1 like fflate). */
const FLAG_UTF8 = 0x0800;

function corrupt(reason: string): Error {
  return new Error(`profile archive is corrupt: ${reason}`);
}

/**
 * Reads the archive's central directory. Restore is driven by it, not by scanning local headers
 * the way fflate's streaming `Unzip` does: a streamed entry carries its sizes in a trailing data
 * descriptor, so a scanner searches the compressed bytes for the next signature, and
 * incompressible content containing `PK\x03\x04` (any embedded zip or crx) is cut into garbage
 * entries. The central directory holds every size, for old (`zipSync`) and new archives alike.
 */
async function readCentralDirectory(handle: ZipReadHandle): Promise<CentralEntry[]> {
  const fileSize = await handle.size();
  if (fileSize < EOCD_MIN_BYTES) throw corrupt('too short');
  const tailLength = Math.min(fileSize, EOCD_MAX_BYTES);
  const tail = await readFully(handle, new Uint8Array(tailLength), fileSize - tailLength);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - EOCD_MIN_BYTES; i >= 0 && eocd < 0; i--) {
    if (tailView.getUint32(i, true) === EOCD_SIGNATURE) eocd = i;
  }
  if (eocd < 0) throw corrupt('no end of central directory');
  const count = tailView.getUint16(eocd + 10, true);
  const cdSize = tailView.getUint32(eocd + 12, true);
  const cdOffset = tailView.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === ZIP32_LIMIT || cdOffset === ZIP32_LIMIT) {
    throw corrupt('zip64 archives are not supported');
  }
  if (cdOffset + cdSize > fileSize) throw corrupt('central directory out of range');
  const cd = await readFully(handle, new Uint8Array(cdSize), cdOffset);
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const latin1 = new TextDecoder('latin1');
  const entries: CentralEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_HEADER_BYTES > cd.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw corrupt('bad central directory entry');
    }
    const flags = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const rawName = cd.subarray(at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength);
    entries.push({
      name: ((flags & FLAG_UTF8) !== 0 ? utf8 : latin1).decode(rawName),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      localHeaderOffset: view.getUint32(at + 42, true),
    });
    at += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Streams one member's compressed bytes through native zlib inflate (or as is, when stored) into
 * `out`, checking the recorded size and CRC: a damaged archive fails instead of restoring garbage.
 */
async function extractEntry(
  archive: ZipReadHandle,
  entry: CentralEntry,
  out: ZipWriteHandle,
): Promise<void> {
  if (entry.method !== METHOD_DEFLATE && entry.method !== METHOD_STORED) {
    throw corrupt(`unsupported compression method ${entry.method}`);
  }
  const header = await readFully(
    archive,
    new Uint8Array(LOCAL_HEADER_BYTES),
    entry.localHeaderOffset,
  );
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (headerView.getUint32(0, true) !== LOCAL_SIGNATURE) throw corrupt('bad local header');
  const start =
    entry.localHeaderOffset +
    LOCAL_HEADER_BYTES +
    headerView.getUint16(26, true) +
    headerView.getUint16(28, true);
  async function* compressed(): AsyncGenerator<Uint8Array> {
    for (let at = 0; at < entry.compressedSize; at += RESTORE_CHUNK_BYTES) {
      const length = Math.min(RESTORE_CHUNK_BYTES, entry.compressedSize - at);
      // A fresh buffer per slice: zlib may still hold the previous one.
      yield await readFully(archive, new Uint8Array(length), start + at);
      await yieldToEventLoop();
    }
  }
  let produced = 0;
  let crc = 0;
  const write = async (data: AsyncIterable<Uint8Array>): Promise<void> => {
    for await (const chunk of data) {
      produced += chunk.length;
      if (produced > entry.size) throw corrupt('a member is larger than recorded');
      crc = crc32(chunk, crc);
      await out.write(chunk);
    }
  };
  if (entry.method === METHOD_STORED) await write(compressed());
  else await pipeline(compressed(), createInflateRaw(), write);
  if (produced !== entry.size || crc !== entry.crc)
    throw corrupt('a member does not match its CRC');
}

/**
 * Extracts the zip file `archivePath` into `destDir`, creating parents as needed and writing each
 * member in bounded slices as it decompresses (files 0600). Reads archives of the streaming zipper
 * and of the earlier in-memory `zipSync` alike. Every entry is confined to `destDir` through the
 * kernel zip-slip guard, and all of them are checked before the first file is written.
 *
 * @throws `PATH_NOT_ALLOWED` for an entry that would escape `destDir`.
 */
export async function unzipFileToDirectory(
  archivePath: string,
  destDir: string,
  fs: ZipFs,
): Promise<void> {
  const archive = await fs.openRead(archivePath);
  try {
    const members: { readonly entry: CentralEntry; readonly path: string }[] = [];
    for (const entry of await readCentralDirectory(archive)) {
      // Directory entries end in '/'; files recreate the tree.
      if (entry.name.endsWith('/')) continue;
      members.push({ entry, path: resolveZipEntry(destDir, entry.name) });
    }
    for (const { entry, path } of members) {
      await fs.mkdir(dirname(path));
      const out = await fs.openWrite(path, SECRET_FILE_MODE);
      try {
        await extractEntry(archive, entry, out);
      } finally {
        await out.close();
      }
    }
  } finally {
    await archive.close();
  }
}

/** The `node:fs/promises` implementation of the file-handle part of {@link ZipFs}. */
export function createNodeZipFs(): Pick<ZipFs, 'openRead' | 'openWrite' | 'createTemp' | 'rename'> {
  const openWrite = async (path: string, mode: number): Promise<ZipWriteHandle> => {
    const handle = await open(path, 'w', mode);
    try {
      // `mode` applies only when the file is created; an existing file is truncated and re-moded.
      await handle.chmod(mode);
    } catch (error) {
      await handle.close();
      throw error;
    }
    return {
      async write(data) {
        let offset = 0;
        while (offset < data.length) {
          const { bytesWritten } = await handle.write(data, offset, data.length - offset);
          offset += bytesWritten;
        }
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  };
  return {
    async openRead(path) {
      const handle = await open(path, 'r');
      return {
        async read(buffer, position) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          return bytesRead;
        },
        size: async () => (await handle.stat()).size,
        close: () => handle.close(),
      };
    },
    openWrite,
    async createTemp(path, mode) {
      const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      return { path: temp, handle: await openWrite(temp, mode) };
    },
    rename: (from, to) => rename(from, to),
  };
}

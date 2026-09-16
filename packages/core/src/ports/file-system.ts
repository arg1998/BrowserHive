/** @module ports/file-system — general filesystem capability for app services (outbox sweeper, backups, purge); adapters live in `infra/fs`. */

/** Metadata of one path. Sizes and times are numbers (bytes, epoch ms). */
export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/** Options for {@link FileSystem.rm}. */
export interface RemoveOptions {
  /** Remove directories and their contents. */
  readonly recursive?: boolean;
}

/** Options for {@link FileSystem.mkdir}. */
export interface MkdirOptions {
  /** Unix mode of created directories (default `0o700`). */
  readonly mode?: number;
}

/**
 * Minimal async filesystem port. Every method is total over missing paths where that is the
 * natural answer (`stat` → `null`, `readdir` → `[]`, `unlink`/`rm` → no-op) so callers do not
 * branch on `ENOENT`. Other failures (permissions, busy files) reject with the native error.
 */
export interface FileSystem {
  /** Metadata of `path`, or `null` when it does not exist. */
  stat(path: string): Promise<FileStat | null>;
  /** Entry names (not paths) of a directory; `[]` when it does not exist. */
  readdir(path: string): Promise<readonly string[]>;
  /** Removes one file; a missing file is not an error. */
  unlink(path: string): Promise<void>;
  /** Removes a path (directories only with `recursive`); a missing path is not an error. */
  rm(path: string, options?: RemoveOptions): Promise<void>;
  /** Creates a directory and its parents. */
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  /** Reads a UTF-8 text file. */
  readFile(path: string): Promise<string>;
  /** Writes a UTF-8 text file (mode applies to a new file only). */
  writeFile(path: string, data: string, options?: MkdirOptions): Promise<void>;
}

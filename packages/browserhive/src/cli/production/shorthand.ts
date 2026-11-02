/** @module cli/production/shorthand — finds the first `bh` on `PATH` the way the shells do and decides whether it is BrowserHive's shorthand (the `doctor` `bh` row, spec 08 §7.1) */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { ShorthandLookup } from '../deps.ts';

/** The filesystem facts the lookup needs; injected so every OS is testable on any OS. */
export interface ShorthandFs {
  /** `null` when `path` does not exist or cannot be stat'ed (symlinks are followed). */
  stat(path: string): { readonly isFile: boolean; readonly mode: number } | null;
  /** The canonical path (symlinks resolved). Throws when it cannot be resolved. */
  realpath(path: string): string;
  /** At most `maxBytes` from the start of `path`. Throws when it cannot be read. */
  read(path: string, maxBytes: number): Uint8Array;
}

/** Inputs of {@link findShorthand}. */
export interface ShorthandInput {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: ShorthandFs;
}

/** The command name being looked up. */
const NAME = 'bh';
/** The file both bin entries point at, as it appears under any install layout. */
const BIN_SUFFIX = 'browserhive/dist/bin.js';
/** Shims are a few hundred bytes; anything bigger is a real program, not a pointer to ours. */
const SHIM_MAX_BYTES = 64 * 1024;
/** cmd.exe's default when `PATHEXT` is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function envValue(input: ShorthandInput, name: string): string | undefined {
  if (input.platform !== 'win32') return input.env[name];
  // Windows variable names are case-insensitive (`Path` is the usual spelling).
  const key = Object.keys(input.env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : input.env[key];
}

/** File names a shell would run for `bh`: `bh` on POSIX; PowerShell's `.ps1` plus `PATHEXT` on Windows. */
function candidateNames(input: ShorthandInput): readonly string[] {
  if (input.platform !== 'win32') return [NAME];
  const exts = ['.ps1', ...(envValue(input, 'PATHEXT') ?? DEFAULT_PATHEXT).split(';')]
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'));
  return [...new Set(exts)].map((ext) => `${NAME}${ext}`);
}

function pathDirs(input: ShorthandInput): readonly string[] {
  const raw = envValue(input, 'PATH') ?? '';
  const delimiter = input.platform === 'win32' ? ';' : ':';
  return raw
    .split(delimiter)
    .map((dir) => (input.platform === 'win32' ? dir.trim().replace(/^"(.*)"$/, '$1') : dir))
    .filter((dir) => dir !== '');
}

function normalise(text: string): string {
  return text.replaceAll('\\', '/').toLowerCase();
}

function decode(bytes: Uint8Array): string {
  // npm's and pnpm's shims are UTF-8; Bun's `.bunx` files are UTF-16LE.
  return bytes.includes(0)
    ? new TextDecoder('utf-16le').decode(bytes)
    : new TextDecoder().decode(bytes);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Whether one match is BrowserHive's: it resolves to a `browserhive/dist/bin.js`, or it is a
 * small shim naming one, or it is byte-identical to the `browserhive` shim beside it.
 */
function isBrowserHive(input: ShorthandInput, dir: string, name: string): boolean {
  const path = input.platform === 'win32' ? win32 : posix;
  const file = path.join(dir, name);
  if (normalise(input.fs.realpath(file)).endsWith(BIN_SUFFIX)) return true;
  const ext = name.slice(NAME.length);
  // Bun's Windows `.exe` is a generic launcher that reads the `.bunx` file next to it.
  const pointer = ext === '.exe' ? path.join(dir, `${NAME}.bunx`) : file;
  if (input.fs.stat(pointer)?.isFile !== true) return false;
  const bytes = input.fs.read(pointer, SHIM_MAX_BYTES + 1);
  if (bytes.length > SHIM_MAX_BYTES) return false;
  if (normalise(decode(bytes)).includes(BIN_SUFFIX)) return true;
  const sibling = path.join(dir, `browserhive${ext === '.exe' ? '.bunx' : ext}`);
  if (input.fs.stat(sibling)?.isFile !== true) return false;
  return sameBytes(bytes, input.fs.read(sibling, SHIM_MAX_BYTES + 1));
}

/**
 * Finds the first `bh` on `PATH`. On Windows every match in the first directory that has one is
 * checked (cmd.exe and PowerShell pick different extensions from the same directory). Shell
 * aliases and functions are invisible to a child process and are not detected.
 *
 * @returns What the first `bh` is; `unknown` when a match could not be read.
 */
export function findShorthand(input: ShorthandInput): ShorthandLookup {
  const names = candidateNames(input);
  const path = input.platform === 'win32' ? win32 : posix;
  for (const dir of pathDirs(input)) {
    const matches = names.filter((name) => {
      const stat = input.fs.stat(path.join(dir, name));
      if (stat?.isFile !== true) return false;
      // POSIX shells skip files without an execute bit and keep searching.
      return input.platform === 'win32' || (stat.mode & 0o111) !== 0;
    });
    const first = matches[0];
    if (first === undefined) continue;
    for (const name of matches) {
      const file = path.join(dir, name);
      try {
        if (!isBrowserHive(input, dir, name)) return { kind: 'other', path: file };
      } catch (err) {
        return {
          kind: 'unknown',
          path: file,
          reason: err instanceof Error ? err.message : 'unreadable',
        };
      }
    }
    return { kind: 'browserhive', path: path.join(dir, first) };
  }
  return { kind: 'absent' };
}

/** The real filesystem behind {@link ShorthandFs}. */
export const nodeShorthandFs: ShorthandFs = {
  stat: (path) => {
    try {
      const stat = statSync(path);
      return { isFile: stat.isFile(), mode: stat.mode };
    } catch {
      // Missing, a broken link or a directory we may not list: the shell skips it too.
      return null;
    }
  },
  realpath: (path) => realpathSync(path),
  read: (path, maxBytes) => {
    const fd = openSync(path, 'r');
    try {
      const buffer = new Uint8Array(maxBytes);
      const length = readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, length);
    } finally {
      closeSync(fd);
    }
  },
};

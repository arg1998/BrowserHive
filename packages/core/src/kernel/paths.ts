/** @module kernel/paths — filesystem sandbox: root containment, symlink-safe resolution, zip-slip guard (D-24). */

import { realpath as fsRealpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { AppError } from './errors/app-error.ts';

/** True if `child` is `root` itself or lives beneath it, after both are absolute+normalised. */
export function isWithin(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Injectable `realpath` for tests; production uses `node:fs/promises`. */
export type RealpathFn = (path: string) => Promise<string>;

/**
 * Resolves `realpath` for a path that may not exist yet. Walks up to the nearest existing
 * ancestor, canonicalises that (resolving any symlinks in the existing prefix), then re-appends
 * the not-yet-created tail. This sandboxes a *destination* path for a file about to be written
 * while still defeating symlink escapes in the portion that already exists.
 */
export async function realpathAllowingMissing(
  target: string,
  realpathFn: RealpathFn = fsRealpath,
): Promise<string> {
  let current = resolve(target);
  const tail: string[] = [];
  // Bounded by path depth; terminates at the filesystem root.
  for (;;) {
    try {
      const real = await realpathFn(current);
      return tail.length === 0 ? real : resolve(real, ...tail.reverse());
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const parent = dirname(current);
      if (parent === current) {
        // Reached the root without finding an existing ancestor — return the normalised path.
        return resolve(target);
      }
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/** Options for {@link resolveWithinRoots}. */
export interface ResolveWithinRootsOptions {
  /** Allowed roots (absolute). The first is where a relative `requested` is resolved when `base` is unset. */
  readonly roots: readonly string[];
  /** Directory a relative `requested` resolves against. Defaults to `roots[0]`. */
  readonly base?: string;
  /** Appended to the public message when a relative path is meaningful for this caller. */
  readonly relativeHint?: string;
  /** Injected for tests. */
  readonly realpath?: RealpathFn;
}

/**
 * Resolves a tool-supplied path and asserts it lands under one of `roots` after symlink
 * resolution (`..` traversal and planted symlinks both fail).
 *
 * @returns The canonical absolute path.
 * @throws `PATH_NOT_ALLOWED` with `{ path, roots }` when the path escapes every root.
 */
export async function resolveWithinRoots(
  requested: string,
  options: ResolveWithinRootsOptions,
): Promise<string> {
  const realpathFn = options.realpath ?? fsRealpath;
  const roots = await Promise.all(options.roots.map((r) => realpathAllowingMissing(r, realpathFn)));
  const base = options.base ?? options.roots[0] ?? '/';
  const candidate = isAbsolute(requested) ? requested : resolve(base, requested);
  const resolved = await realpathAllowingMissing(candidate, realpathFn);
  if (!roots.some((root) => isWithin(root, resolved))) {
    throw pathNotAllowed(requested, roots, options.relativeHint);
  }
  return resolved;
}

/**
 * Builds the `PATH_NOT_ALLOWED` error with its stable message text. The roots list is part of
 * the private message; the HTTP/MCP projection decides whether it is public (spec 10 §1.3).
 */
export function pathNotAllowed(
  path: string,
  roots: readonly string[],
  relativeHint?: string,
): AppError<'PATH_NOT_ALLOWED'> {
  const rootList = roots.map((r) => `'${r}'`).join(', ');
  let suffix = '';
  if (roots.length > 0) {
    suffix = ` Allowed roots: ${rootList}. Pass an absolute path under one of these`;
    suffix += relativeHint !== undefined ? `, or a relative path (${relativeHint}).` : '.';
  }
  return new AppError(
    'PATH_NOT_ALLOWED',
    { path, roots: [...roots] },
    {
      publicMessage: `Path '${path}' is outside the allowed sandbox roots.`,
      message: `Path '${path}' is outside the allowed sandbox roots.${suffix}`,
    },
  );
}

/**
 * Zip-slip guard: true when an archive entry name is safe to extract under a root. Rejects
 * absolute paths, drive letters, backslashes, `..` segments, empty names and NUL bytes.
 */
export function isSafeZipEntry(name: string): boolean {
  if (name.length === 0 || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const normalized = posix.normalize(name);
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/'))
    return false;
  return normalized.split('/').every((segment) => segment !== '..');
}

/**
 * Resolves an archive entry under `root`, refusing anything {@link isSafeZipEntry} rejects or
 * that would land outside `root` after normalisation.
 *
 * @throws `PATH_NOT_ALLOWED` with `{ path: name, roots: [root] }`.
 */
export function resolveZipEntry(root: string, name: string): string {
  if (!isSafeZipEntry(name)) throw pathNotAllowed(name, [root]);
  const target = resolve(root, name);
  if (!isWithin(resolve(root), target)) throw pathNotAllowed(name, [root]);
  return target;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

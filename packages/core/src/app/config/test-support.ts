/** @module app/config/test-support — in-memory `ConfigFs`, synthetic host and a `resolve()` shortcut for the resolver suites */
import { dirname, resolve as resolvePath } from 'node:path';
import type { HostEnvironment } from '../../ports/host-environment.ts';
import type { ConfigFs } from './discover.ts';
import type { ConfigFailure } from './failure.ts';
import { type ResolveConfigInput, type ResolvedConfigBundle, resolveConfig } from './resolve.ts';

/** One GiB. */
export const GIB = 1024 ** 3;

/**
 * A synthetic Linux host with 12 GiB RAM (derived `maxSessions` = 8).
 *
 * @returns The host record with `overrides` applied.
 */
export function fakeHost(overrides: Partial<HostEnvironment> = {}): HostEnvironment {
  return {
    platform: 'linux',
    arch: 'x64',
    release: '6.0.0-test',
    homeDir: '/home/tester',
    tmpDir: '/tmp',
    totalMemoryBytes: 12 * GIB,
    cpuCount: 4,
    isTty: { stdout: false, stderr: false },
    env: {},
    ...overrides,
  };
}

/**
 * An in-memory file system keyed by absolute path.
 *
 * @returns A `ConfigFs` over `files`; directories are every path prefix of a file.
 */
export function memoryFs(files: Readonly<Record<string, string>>, mode = 0o600): ConfigFs {
  // Keys and lookups go through `path.resolve`: the identity for POSIX paths on POSIX, and on Windows
  // `/work/x` and the resolver's `\work\x` both become `C:\work\x`.
  const byPath = new Map<string, string>();
  const dirs = new Set<string>();
  for (const [key, text] of Object.entries(files)) {
    const path = resolvePath(key);
    byPath.set(path, text);
    for (let dir = dirname(path); !dirs.has(dir); dir = dirname(dir)) {
      dirs.add(dir);
      if (dirname(dir) === dir) break;
    }
  }
  return {
    readFile(path) {
      const text = byPath.get(resolvePath(path));
      if (text === undefined) {
        const error: Error & { code?: string } = new Error(`ENOENT: ${path}`);
        error.code = dirs.has(resolvePath(path)) ? 'EISDIR' : 'ENOENT';
        throw error;
      }
      return text;
    },
    stat(path) {
      const key = resolvePath(path);
      if (byPath.has(key)) return { isFile: true, mode };
      if (dirs.has(key)) return { isFile: false, mode: 0o700 };
      return undefined;
    },
  };
}

/** Partial resolver input; everything else defaults to an isolated run in `/work`. */
export type ResolveCase = Partial<ResolveConfigInput> & {
  /** Files for {@link memoryFs}. */
  readonly files?: Readonly<Record<string, string>>;
};

/**
 * Run the resolver with defaults for an isolated test (`cwd=/work`, empty env, no argv).
 *
 * @returns The resolver result.
 */
export function resolve(input: ResolveCase = {}) {
  const { files, ...rest } = input;
  const result = resolveConfig({
    argv: [],
    env: {},
    cwd: '/work',
    host: fakeHost(),
    fs: memoryFs(files ?? {}),
    ...rest,
  });
  return result.ok
    ? { ok: true as const, value: posixView(result.value) }
    : { ok: false as const, error: posixFailure(result.error) };
}

/** An absolute Windows path inside a string: `C:\a\b` or the drive-relative `\a\b` `path.join` makes of `/a/b`. */
const WINDOWS_PATH_RE = /(?:\b[A-Za-z]:)?\\[^\s'"#,;)]*/g;

/**
 * The suites state paths POSIX-style (`/work/browserhive.config.json`). On Windows the resolver
 * builds them with `node:path` (`\work\…`, or `C:\etc\…` once resolved), which is correct there;
 * this maps them back so one expectation covers both. The identity on every other platform.
 */
export function posixPathsIn(text: string, platform: string = process.platform): string {
  if (platform !== 'win32') return text;
  return text.replace(WINDOWS_PATH_RE, (path) =>
    path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/'),
  );
}

/** {@link posixPathsIn} over every string of plain data (arrays and plain objects, recursively). */
export function posixView<T>(value: T): T {
  if (process.platform !== 'win32') return value;
  if (typeof value === 'string') return posixPathsIn(value) as T;
  // Copies keep the original's frozenness: the suites assert the resolver deep-freezes its output.
  const keep = <V extends object>(copy: V): V =>
    Object.isFrozen(value) ? Object.freeze(copy) : copy;
  if (Array.isArray(value)) return keep(value.map((v) => posixView(v))) as T;
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return keep(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, posixView(v)]))) as T;
  }
  return value;
}

function posixFailure(failure: ConfigFailure): ConfigFailure {
  if (process.platform !== 'win32') return failure;
  return {
    code: failure.code,
    exitCode: failure.exitCode,
    problems: posixView(failure.problems),
    render: () => posixPathsIn(failure.render()),
  };
}

/**
 * Run the resolver and unwrap the bundle.
 *
 * @returns The bundle.
 * @throws Error with the rendered failure when resolution fails.
 */
export function resolveOk(input: ResolveCase = {}): ResolvedConfigBundle {
  const result = resolve(input);
  if (!result.ok) throw new Error(`expected success, got:\n${result.error.render()}`);
  return result.value;
}

/**
 * Run the resolver and unwrap the failure.
 *
 * @returns The failure.
 * @throws Error when resolution unexpectedly succeeds.
 */
export function resolveErr(input: ResolveCase = {}): ConfigFailure {
  const result = resolve(input);
  if (result.ok) throw new Error('expected failure, got success');
  return result.error;
}

/** A syntactically valid agent token for `authTokens`. */
export const TOKEN_A = `agent-a:${'a'.repeat(32)}`;
/** A second valid agent token. */
export const TOKEN_B = `agent-b:${'b'.repeat(32)}`;

/** @module app/config/test-support — in-memory `ConfigFs`, synthetic host and a `resolve()` shortcut for the resolver suites */
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
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/') || '/');
  }
  return {
    readFile(path) {
      const text = files[path];
      if (text === undefined) {
        const error: Error & { code?: string } = new Error(`ENOENT: ${path}`);
        error.code = dirs.has(path) ? 'EISDIR' : 'ENOENT';
        throw error;
      }
      return text;
    },
    stat(path) {
      if (path in files) return { isFile: true, mode };
      if (dirs.has(path)) return { isFile: false, mode: 0o700 };
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
  return resolveConfig({
    argv: [],
    env: {},
    cwd: '/work',
    host: fakeHost(),
    fs: memoryFs(files ?? {}),
    ...rest,
  });
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

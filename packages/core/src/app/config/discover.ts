/** @module app/config/discover — config-file discovery: explicit path → cwd → data dir, strict JSON with line/column errors (spec 08 §3) */
import { join } from 'node:path';
import { err, ok, type Result } from '../../kernel/result.ts';
import type { ConfigProblem } from './failure.ts';
import { isJsonObject, type JsonValue, parseJson } from './json-parse.ts';

/** File name of the config file (spec 08 §3). */
export const CONFIG_FILE_NAME = 'browserhive.config.json';

/** Minimal stat result the resolver needs. */
export interface ConfigFileStat {
  readonly isFile: boolean;
  /** POSIX mode bits (`doctor` warns when broader than 0600 for files carrying secrets). */
  readonly mode: number;
}

/** Synchronous file system access injected into the resolver (spec 08 §6: pure, injected `fs`). */
export interface ConfigFs {
  /** Read a UTF-8 text file; throws on any error (the message becomes the reason). */
  readFile(path: string): string;
  /** Stat a path; `undefined` when it does not exist. */
  stat(path: string): ConfigFileStat | undefined;
}

/** Where a config file was found. */
export type ConfigFileOrigin = 'explicit' | 'cwd' | 'dataDir';

/** A discovered and parsed config file. */
export interface DiscoveredConfigFile {
  /** Absolute path as discovered (the location shown in messages). */
  readonly path: string;
  readonly origin: ConfigFileOrigin;
  /** The top-level JSON object (including `$schema` if present). */
  readonly json: { readonly [key: string]: JsonValue };
  /** File mode from `stat`, when available. */
  readonly mode?: number;
}

/** Inputs to {@link discoverConfigFile}. */
export interface DiscoverInput {
  /** Explicit path from `--config` / `BROWSERHIVE_CONFIG` / `configFile`, already absolute. */
  readonly explicit?: { readonly path: string; readonly location: string };
  readonly cwd: string;
  /** Data dir from the pre-pass (defaults, env, CLI only). */
  readonly dataDir: string;
  readonly fs: ConfigFs;
}

function cannotRead(path: string, reason: string, location: string): ConfigProblem {
  return {
    code: 'CONFIG_FILE_INVALID',
    source: 'file',
    location,
    message: `cannot read ${path}: ${reason}`,
  };
}

function errorReason(error: unknown): string {
  if (error instanceof Error) {
    const code: unknown = 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return 'no such file';
    if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
    if (code === 'EISDIR') return 'is a directory';
    return error.message;
  }
  return String(error);
}

/**
 * Read and parse one config file.
 *
 * @returns The parsed object, or the `cannot read …` problem (spec 08 §4).
 */
export function readConfigFile(
  path: string,
  origin: ConfigFileOrigin,
  fs: ConfigFs,
  location: string = `file:${path}`,
): Result<DiscoveredConfigFile, ConfigProblem> {
  let text: string;
  try {
    text = fs.readFile(path);
  } catch (error) {
    return err(cannotRead(path, errorReason(error), location));
  }
  const parsed = parseJson(text);
  if (!parsed.ok) {
    const { line, column, message } = parsed.error;
    return err(
      cannotRead(path, `invalid JSON at line ${line}, column ${column}: ${message}`, location),
    );
  }
  if (!isJsonObject(parsed.value)) {
    return err(cannotRead(path, 'expected a JSON object at the top level', location));
  }
  const mode = fs.stat(path)?.mode;
  return ok({ path, origin, json: parsed.value, ...(mode !== undefined && { mode }) });
}

/**
 * Discover the config file (spec 08 §3): the explicit path (missing ⇒ usage error), else
 * `./browserhive.config.json` in cwd, else `<dataDir>/browserhive.config.json`; absent
 * candidates mean no file layer.
 *
 * @returns The discovered file, `undefined` when none exists, or the problem that stops discovery.
 */
export function discoverConfigFile(
  input: DiscoverInput,
): Result<DiscoveredConfigFile | undefined, ConfigProblem> {
  if (input.explicit !== undefined) {
    const { path, location } = input.explicit;
    const stat = input.fs.stat(path);
    if (stat === undefined) return err(cannotRead(path, 'no such file', location));
    if (!stat.isFile) return err(cannotRead(path, 'is a directory', location));
    return readConfigFile(path, 'explicit', input.fs, location);
  }
  const candidates: ReadonlyArray<{ readonly path: string; readonly origin: ConfigFileOrigin }> = [
    { path: join(input.cwd, CONFIG_FILE_NAME), origin: 'cwd' },
    { path: join(input.dataDir, CONFIG_FILE_NAME), origin: 'dataDir' },
  ];
  for (const candidate of candidates) {
    const stat = input.fs.stat(candidate.path);
    if (stat === undefined || !stat.isFile) continue;
    return readConfigFile(candidate.path, candidate.origin, input.fs);
  }
  return ok(undefined);
}

/** Message of the data-dir-config rule (spec 08 §3). */
export const DATA_DIR_IN_DATA_DIR_MESSAGE =
  'dataDir cannot be set from a config file located in the data dir';

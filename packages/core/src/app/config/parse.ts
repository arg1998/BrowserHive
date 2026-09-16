/** @module app/config/parse — parse one raw entry with its key's parser; relative paths, port 0 for the programmatic API, log-module registry check (spec 08 §6 step 3) */
import { isAbsolute, resolve } from 'node:path';
import { CONFIG_SHAPE, type ConfigKey, keyMeta } from '@browserhive/contracts/config';
import { err, ok, type Result } from '../../kernel/result.ts';
import type { ConfigProblem } from './failure.ts';
import { keyKind, quoteRaw } from './kinds.ts';
import type { RawEntry } from './layers.ts';

/** A parsed entry: the canonical value plus where it came from. */
export interface ParsedEntry {
  readonly key: ConfigKey;
  readonly value: unknown;
  readonly source: RawEntry['source'];
  readonly location: string;
}

/** Options of {@link parseEntry}. */
export interface ParseOptions {
  /** Base directory for relative paths supplied by env, CLI and overrides. */
  readonly cwd: string;
  /** Logger module registry; when given, `logLevel` module names outside it are usage errors. */
  readonly knownLogModules?: readonly string[];
}

const RESERVED_SUFFIX = 'is reserved for a future release and cannot be set.';
const GOT_CLAUSE = /, got .*\.$/s;

/**
 * Turn the parser's first issue into the `Expected …` clause of spec 08 §4: grammar failures
 * (`Expected <grammar>, got "x".`) drop the `got` clause, refinement messages are kept, and
 * zod's own messages (enum members, union type mismatches) are replaced by the key's grammar.
 *
 * @returns A sentence ending with a period.
 */
export function expectedClause(key: ConfigKey, issueMessage: string): string {
  if (!issueMessage.startsWith('Expected ')) {
    const grammar = keyMeta(key).grammar;
    if (grammar !== undefined) return `Expected ${grammar}.`;
  }
  const text = issueMessage.replace(GOT_CLAUSE, '.');
  return text.endsWith('.') ? text : `${text}.`;
}

function invalid(entry: RawEntry, expected: string): ConfigProblem {
  return {
    code: 'CONFIG_INVALID',
    key: entry.key,
    source: entry.source,
    location: entry.location,
    message: `invalid value for ${entry.display}: ${quoteRaw(entry.raw)}. ${expected}`,
  };
}

function isLevelSpec(
  value: unknown,
): value is { readonly root: string; readonly modules: Readonly<Record<string, string>> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'modules' in value &&
    typeof value.modules === 'object' &&
    value.modules !== null
  );
}

/**
 * Parse one raw entry with the key's parser. Path keys resolve relative values against
 * `entry.baseDir` (config file dir) or `cwd`; `port: 0` is accepted from programmatic overrides
 * only (ephemeral port for tests); `logLevel` module names are checked against the registry.
 *
 * @returns The canonical value, or the `CONFIG_INVALID` / `CONFIG_RESERVED_KEY` problem.
 */
export function parseEntry(
  entry: RawEntry,
  options: ParseOptions,
): Result<ParsedEntry, ConfigProblem> {
  const done = (value: unknown): Result<ParsedEntry, ConfigProblem> =>
    ok({ key: entry.key, value, source: entry.source, location: entry.location });

  if (entry.key === 'port' && entry.raw === 0 && entry.location.startsWith('options.')) {
    return done(0);
  }
  const parsed = CONFIG_SHAPE[entry.key].safeParse(entry.raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? 'Invalid value.';
    if (first.endsWith(RESERVED_SUFFIX)) {
      return err({
        code: 'CONFIG_RESERVED_KEY',
        key: entry.key,
        source: entry.source,
        location: entry.location,
        message: first,
      });
    }
    return err(invalid(entry, expectedClause(entry.key, first)));
  }
  const value: unknown = parsed.data;
  if (keyKind(entry.key) === 'path' && typeof value === 'string' && !isAbsolute(value)) {
    return done(resolve(entry.baseDir ?? options.cwd, value));
  }
  if (entry.key === 'logLevel' && options.knownLogModules !== undefined && isLevelSpec(value)) {
    const known = options.knownLogModules;
    const unknown = Object.keys(value.modules).filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      return err(
        invalid(entry, `Unknown log module '${unknown[0]}' (expected one of ${known.join(', ')}).`),
      );
    }
  }
  return done(value);
}

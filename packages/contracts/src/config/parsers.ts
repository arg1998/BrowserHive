/** @module contracts/config/parsers — one zod parser per value grammar (spec 08 §2.1); string or canonical typed input, canonical output. Host lives in `host.ts`. */
import { z } from 'zod';
import { LogLevel } from '../enums/log-level.ts';
import { grammarFail as fail, GRAMMAR_META_KEY } from './grammar.ts';

// ---------------------------------------------------------------------------------------------
// boolean
// ---------------------------------------------------------------------------------------------

const BOOL_GRAMMAR = "a boolean: 'true', 'false', '1', '0', 'yes' or 'no'";
const TRUE_WORDS = new Set(['true', '1', 'yes']);
const FALSE_WORDS = new Set(['false', '0', 'no']);

/** Boolean grammar: `true|false|1|0|yes|no` (case-insensitive) or a JSON boolean. */
export const zBool = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx): boolean => {
    if (typeof value === 'boolean') return value;
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    return fail(ctx, BOOL_GRAMMAR, value);
  })
  .meta({ [GRAMMAR_META_KEY]: BOOL_GRAMMAR });

// ---------------------------------------------------------------------------------------------
// duration
// ---------------------------------------------------------------------------------------------

const DURATION_GRAMMAR =
  "a duration like '2h', '30m', '90s', '500ms', or an integer of milliseconds";
const DURATION_RE = /^(\d+)(ms|s|m|h|d)?$/;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Duration grammar: `<int>(ms|s|m|h|d)?`; bare integer = milliseconds. Output: milliseconds. */
export const zDuration = z
  .union([z.number(), z.string()])
  .transform((value, ctx): number => {
    if (typeof value === 'number') {
      return Number.isInteger(value) && value >= 0 ? value : fail(ctx, DURATION_GRAMMAR, value);
    }
    const match = DURATION_RE.exec(value.trim());
    const digits = match?.[1];
    if (digits === undefined) return fail(ctx, DURATION_GRAMMAR, value);
    return Number(digits) * (DURATION_UNIT_MS[match?.[2] ?? 'ms'] ?? 1);
  })
  .meta({ [GRAMMAR_META_KEY]: DURATION_GRAMMAR });

/**
 * Canonical rendering of a millisecond duration (`7200000` → `2h`, `1500` → `1500ms`): the largest
 * unit that divides it exactly.
 *
 * @returns The duration text accepted by {@link zDuration}.
 */
export function formatDuration(ms: number): string {
  for (const unit of ['d', 'h', 'm', 's']) {
    const size = DURATION_UNIT_MS[unit] ?? 1;
    if (ms > 0 && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

// ---------------------------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------------------------

const BYTES_GRAMMAR = "a size like '2GiB', '64MiB', '500MB', or an integer of bytes";
const BYTES_RE = /^(\d+)\s*(b|kib|mib|gib|kb|mb|gb)?$/i;
const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
};

/** Bytes grammar: `<int>(B|KiB|MiB|GiB|KB|MB|GB)?`; binary units are powers of 1024. Output: bytes. */
export const zBytes = z
  .union([z.number(), z.string()])
  .transform((value, ctx): number => {
    if (typeof value === 'number') {
      return Number.isInteger(value) && value >= 0 ? value : fail(ctx, BYTES_GRAMMAR, value);
    }
    const match = BYTES_RE.exec(value.trim());
    const digits = match?.[1];
    if (digits === undefined) return fail(ctx, BYTES_GRAMMAR, value);
    return Number(digits) * (BYTE_UNITS[(match?.[2] ?? 'b').toLowerCase()] ?? 1);
  })
  .meta({ [GRAMMAR_META_KEY]: BYTES_GRAMMAR });

/**
 * Canonical rendering of a byte count using the largest binary unit that divides it exactly.
 *
 * @returns The size text accepted by {@link zBytes}.
 */
export function formatBytes(bytes: number): string {
  for (const unit of ['GiB', 'MiB', 'KiB']) {
    const size = BYTE_UNITS[unit.toLowerCase()] ?? 1;
    if (bytes > 0 && bytes % size === 0) return `${bytes / size}${unit}`;
  }
  return `${bytes}B`;
}

// ---------------------------------------------------------------------------------------------
// integers, ratios, ports
// ---------------------------------------------------------------------------------------------

const INT_RE = /^-?\d+$/;

/**
 * Integer grammar with an inclusive range; accepts a number or a decimal string.
 *
 * @returns A parser producing an integer within `[min, max]`.
 */
export function zInt(min: number, max: number = Number.MAX_SAFE_INTEGER) {
  const grammar =
    max === Number.MAX_SAFE_INTEGER
      ? `an integer >= ${min}`
      : `an integer between ${min} and ${max}`;
  return z
    .union([z.number(), z.string()])
    .transform((value, ctx): number => {
      const n = typeof value === 'number' ? value : INT_RE.test(value.trim()) ? Number(value) : NaN;
      return Number.isInteger(n) && n >= min && n <= max ? n : fail(ctx, grammar, value);
    })
    .meta({ [GRAMMAR_META_KEY]: grammar });
}

const RATIO_GRAMMAR = 'a number between 0 and 1';

/** Ratio grammar: a number in `[0, 1]` (string or number). */
export const zRatio = z
  .union([z.number(), z.string()])
  .transform((value, ctx): number => {
    const n = typeof value === 'number' ? value : Number(value.trim());
    return value !== '' && Number.isFinite(n) && n >= 0 && n <= 1
      ? n
      : fail(ctx, RATIO_GRAMMAR, value);
  })
  .meta({ [GRAMMAR_META_KEY]: RATIO_GRAMMAR });

/** Port grammar: integer 1–65535. Port `0` (ephemeral) is only accepted by the programmatic API. */
export const zPort = zInt(1, 65535).meta({ [GRAMMAR_META_KEY]: 'a port between 1 and 65535' });

// ---------------------------------------------------------------------------------------------
// path, url, string, list, map
// ---------------------------------------------------------------------------------------------

const PATH_GRAMMAR = 'a non-empty file system path';

/** Path grammar: any non-empty string. Resolution against cwd / the config file dir is the resolver's job. */
export const zPath = z
  .string()
  .transform((value, ctx): string => (value.trim() === '' ? fail(ctx, PATH_GRAMMAR, value) : value))
  .meta({ [GRAMMAR_META_KEY]: PATH_GRAMMAR });

const URL_GRAMMAR = "an absolute http: or https: URL like 'http://127.0.0.1:4318'";
// Platform-neutral (no WHATWG `URL` in the ES lib): scheme, authority, optional path/query/fragment.
const HTTP_URL_RE = /^https?:\/\/[^\s/?#@]+(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

/** URL grammar: absolute `http:`/`https:` URL. Output: the trimmed text (validated). */
export const zUrl = z
  .string()
  .transform((value, ctx): string => {
    const text = value.trim();
    return HTTP_URL_RE.test(text) ? text : fail(ctx, URL_GRAMMAR, value);
  })
  .meta({ [GRAMMAR_META_KEY]: URL_GRAMMAR });

const STRING_GRAMMAR = 'a non-empty string';

/** String grammar: as-is, but never empty (an empty value is a usage error, spec 08 §1). */
export const zString = z
  .string()
  .transform((value, ctx): string => (value === '' ? fail(ctx, STRING_GRAMMAR, value) : value))
  .meta({ [GRAMMAR_META_KEY]: STRING_GRAMMAR });

const LIST_GRAMMAR = "a comma-separated list like 'a,b,c' (or a JSON array of strings)";

/** List grammar: env/CLI `a,b,c` (trimmed, empty items rejected) or a JSON array of strings. */
export const zList = z
  .union([z.array(z.string()), z.string()])
  .transform((value, ctx): readonly string[] => {
    const items = (typeof value === 'string' ? value.split(',') : value).map((item) => item.trim());
    if (items.length === 1 && items[0] === '' && typeof value === 'string') return [];
    return items.some((item) => item === '') ? fail(ctx, LIST_GRAMMAR, value) : items;
  })
  .meta({ [GRAMMAR_META_KEY]: LIST_GRAMMAR });

const MAP_GRAMMAR = "a comma-separated map like 'k=v,k2=v2' (or a JSON object of strings)";

/** Map grammar: env/CLI `k=v,k2=v2` (first `=` splits) or a JSON object of strings. */
export const zMap = z
  .union([z.record(z.string(), z.string()), z.string()])
  .transform((value, ctx): Readonly<Record<string, string>> => {
    if (typeof value !== 'string') return { ...value };
    if (value.trim() === '') return {};
    const out: Record<string, string> = {};
    for (const pair of value.split(',')) {
      const eq = pair.indexOf('=');
      const k = eq < 0 ? '' : pair.slice(0, eq).trim();
      if (k === '') return fail(ctx, MAP_GRAMMAR, value);
      out[k] = pair.slice(eq + 1).trim();
    }
    return out;
  })
  .meta({ [GRAMMAR_META_KEY]: MAP_GRAMMAR });

// ---------------------------------------------------------------------------------------------
// level spec, max sessions, reserved enums
// ---------------------------------------------------------------------------------------------

/** Parsed `logLevel` spec: a root level plus per-module overrides. */
export interface LevelSpec {
  /** Level for every module without an override. */
  readonly root: LogLevel;
  /** Per-module levels (`sessions=debug`); module names are validated by the logger registry in core. */
  readonly modules: Readonly<Record<string, LogLevel>>;
}

const LEVEL_SPEC_GRAMMAR =
  "a level spec like 'info' or 'info,sessions=debug,http=warn' (levels: error, warn, info, debug, trace)";
const MODULE_NAME_RE = /^[a-z][a-z0-9._-]*$/;
const LevelSpecObject = z.object({ root: LogLevel, modules: z.record(z.string(), LogLevel) });

/**
 * Level-spec grammar: `<level>[,<module>=<level>...]` or the canonical `{ root, modules }` object.
 * Module names are checked for syntax only here; unknown modules are a usage error in the resolver.
 */
export const zLevelSpec = z
  .union([LevelSpecObject, z.string()])
  .transform((value, ctx): LevelSpec => {
    if (typeof value !== 'string') return { root: value.root, modules: { ...value.modules } };
    const [rootText = '', ...pairs] = value.split(',').map((part) => part.trim());
    const root = LogLevel.safeParse(rootText);
    if (!root.success) return fail(ctx, LEVEL_SPEC_GRAMMAR, value);
    const modules: Record<string, LogLevel> = {};
    for (const pair of pairs) {
      const [name = '', levelText = '', ...rest] = pair.split('=');
      const level = LogLevel.safeParse(levelText);
      if (rest.length > 0 || !MODULE_NAME_RE.test(name) || !level.success) {
        return fail(ctx, LEVEL_SPEC_GRAMMAR, value);
      }
      modules[name] = level.data;
    }
    return { root: root.data, modules };
  })
  .meta({ [GRAMMAR_META_KEY]: LEVEL_SPEC_GRAMMAR });

/**
 * Canonical rendering of a {@link LevelSpec} (`info,sessions=debug`).
 *
 * @returns The text accepted by {@link zLevelSpec}.
 */
export function formatLevelSpec(spec: LevelSpec): string {
  const pairs = Object.entries(spec.modules).map(([name, level]) => `${name}=${level}`);
  return [spec.root, ...pairs].join(',');
}

/** Canonical `maxSessions` value: a positive integer or `unbounded`. */
export type MaxSessions = number | 'unbounded';

const MAX_SESSIONS_GRAMMAR = "an integer >= 1 or 'unbounded'";

/** Max-sessions grammar: integer ≥ 1, `unbounded`, or its alias `infinity` (both case-insensitive). */
export const zMaxSessions = z
  .union([z.number(), z.string()])
  .transform((value, ctx): MaxSessions => {
    const word = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
    if (word === 'unbounded' || word === 'infinity') return 'unbounded';
    if (word !== undefined && !INT_RE.test(word)) return fail(ctx, MAX_SESSIONS_GRAMMAR, value);
    const n = word === undefined ? value : Number(word);
    return typeof n === 'number' && Number.isInteger(n) && n >= 1
      ? n
      : fail(ctx, MAX_SESSIONS_GRAMMAR, value);
  })
  .meta({ [GRAMMAR_META_KEY]: MAX_SESSIONS_GRAMMAR });

/**
 * Build the reserved-member error text of spec 08 §4 (`'proxy' is reserved for a future release and
 * cannot be set.`).
 *
 * @returns The message.
 */
export function reservedMessage(name: string): string {
  return `'${name}' is reserved for a future release and cannot be set.`;
}

/**
 * Enum grammar with reserved members: `accepted` are the live members, `reserved` are registered so
 * they fail with the reserved-member message instead of "unknown value".
 *
 * @returns A parser whose output is one of `accepted`.
 */
export function zReservedEnum<const A extends readonly string[]>(
  accepted: A,
  reserved: readonly string[],
) {
  const grammar = `one of: ${accepted.join(', ')}`;
  const live = z.enum(accepted);
  return z
    .string()
    .transform((value, ctx): A[number] => {
      const parsed = live.safeParse(value);
      if (parsed.success) return parsed.data;
      if (reserved.includes(value)) {
        ctx.addIssue({ code: 'custom', message: reservedMessage(value), input: value });
        return z.NEVER;
      }
      return fail(ctx, grammar, value);
    })
    .meta({ [GRAMMAR_META_KEY]: grammar });
}

/**
 * Plain enum grammar carrying a grammar string that lists the members.
 *
 * @returns The enum schema with grammar metadata.
 */
export function zEnumOf<const A extends readonly string[]>(values: A) {
  return z.enum(values).meta({ [GRAMMAR_META_KEY]: `one of: ${values.join(', ')}` });
}

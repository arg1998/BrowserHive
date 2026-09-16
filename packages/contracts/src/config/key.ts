/** @module contracts/config/key — `key(schema, meta)`: attaches per-key metadata (spec 08 §6) via zod `.meta()` */
import { z } from 'zod';
import { GRAMMAR_META_KEY } from './grammar.ts';

/** Help sections a key belongs to (`--help` groups and docs tables). */
export const CONFIG_GROUPS = [
  'server',
  'sessions',
  'stealth',
  'logging',
  'recording',
  'telemetry',
] as const;
/** Union of {@link CONFIG_GROUPS}. */
export type ConfigGroup = (typeof CONFIG_GROUPS)[number];

/** Inputs a derived default is computed from (spec 08 §1). */
export const DERIVED_SOURCES = ['hostMemory', 'platform', 'stealth', 'admin'] as const;
/** Union of {@link DERIVED_SOURCES}. */
export type DerivedSource = (typeof DERIVED_SOURCES)[number];

/** Marker returned by {@link derived}: the default is computed by the resolver from `from`. */
export interface Derived {
  readonly derived: DerivedSource;
}

/**
 * Mark a key's default as derived (`maxSessions` from host RAM, `trace` from `admin`, …).
 *
 * @returns The marker for `key()`.
 */
export function derived(from: DerivedSource): Derived {
  return { derived: from };
}

/** Metadata stored on every key schema and returned by `keyMeta(key)`. */
export type KeyMeta = {
  /** One-line description used by `--help`, the JSON Schema and the docs table. */
  readonly describe: string;
  /** Help section. */
  readonly group: ConfigGroup;
  /** Canonical typed default; absent for derived and optional keys. */
  readonly default?: unknown;
  /** Human rendering of the default (`'2h'`) for help and docs; falls back to `default`. */
  readonly defaultText?: string;
  /** Present when the default is derived; names the input. */
  readonly derivedFrom?: DerivedSource;
  /** Values are rendered `<redacted>` in provenance, `config show` and `/system/config`. */
  readonly secret: boolean;
  /** `true` for boot keys; `false` for the runtime-adjustable ones (`logLevel`, `logFormat`, `otelTraceUrlTemplate`). */
  readonly restartRequired: boolean;
  /** CLI/env only: a config file may not set it (`config`). */
  readonly cliOnly: boolean;
  /** Example values for help and docs. */
  readonly examples?: readonly string[];
  /** Grammar text of the parser (from the parser's metadata). */
  readonly grammar?: string;
};

/** Author-facing metadata accepted by `key()`; `secret`, `restartRequired`, `cliOnly` default to sane values. */
export interface KeyMetaInput {
  readonly describe: string;
  readonly group: ConfigGroup;
  readonly defaultText?: string;
  readonly secret?: boolean;
  readonly restartRequired?: boolean;
  readonly cliOnly?: boolean;
  readonly examples?: readonly string[];
}

/** Meta of a key with a derived default. */
export type DerivedKeyMeta = KeyMetaInput & { readonly default: Derived };
/** Meta of a key with no default (absent unless supplied). */
export type OptionalKeyMeta = KeyMetaInput & { readonly optional: true };
/** Meta of a key with a literal default. */
export type DefaultKeyMeta<T> = KeyMetaInput & { readonly default: T };

function isDerived(value: unknown): value is Derived {
  return typeof value === 'object' && value !== null && 'derived' in value;
}

function toMeta(schema: z.ZodType, input: KeyMetaInput, extra: Partial<KeyMeta>): KeyMeta {
  const grammar = schema.meta()?.[GRAMMAR_META_KEY];
  return {
    describe: input.describe,
    group: input.group,
    secret: input.secret ?? false,
    restartRequired: input.restartRequired ?? true,
    cliOnly: input.cliOnly ?? false,
    ...(input.defaultText !== undefined && { defaultText: input.defaultText }),
    ...(input.examples !== undefined && { examples: input.examples }),
    ...(typeof grammar === 'string' && { grammar }),
    ...extra,
  };
}

/**
 * Attach key metadata to a parser. Three forms: a literal `default` wraps the parser in `.default()`
 * (JSON input may omit it; the output type is required); `default: derived(...)` leaves the parser
 * bare (the resolver supplies the value; the output type is required); `optional: true` wraps it in
 * `.optional()`.
 *
 * @returns The key schema carrying `KeyMeta` in its zod metadata.
 */
export function key<S extends z.ZodType>(schema: S, meta: DerivedKeyMeta): S;
export function key<S extends z.ZodType>(schema: S, meta: OptionalKeyMeta): z.ZodOptional<S>;
export function key<S extends z.ZodType>(
  schema: S,
  meta: DefaultKeyMeta<NoInfer<z.output<S>>>,
): z.ZodDefault<S>;
export function key(
  schema: z.ZodType,
  meta: DerivedKeyMeta | OptionalKeyMeta | DefaultKeyMeta<unknown>,
): z.ZodType {
  if ('optional' in meta) {
    return schema.optional().meta(toMeta(schema, meta, {}));
  }
  if (isDerived(meta.default)) {
    return schema.meta(toMeta(schema, meta, { derivedFrom: meta.default.derived }));
  }
  const value: unknown = meta.default;
  return schema.default(value).meta(toMeta(schema, meta, { default: value }));
}

const KeyMetaSchema = z.object({
  describe: z.string(),
  group: z.enum(CONFIG_GROUPS),
  default: z.unknown().optional(),
  defaultText: z.string().optional(),
  derivedFrom: z.enum(DERIVED_SOURCES).optional(),
  secret: z.boolean(),
  restartRequired: z.boolean(),
  cliOnly: z.boolean(),
  examples: z.array(z.string()).optional(),
  grammar: z.string().optional(),
});

/**
 * Whether a zod metadata object was written by {@link key}.
 *
 * @returns `true` when `meta` carries `describe` and `group`.
 */
export function isKeyMeta(meta: unknown): boolean {
  return KeyMetaSchema.safeParse(meta).success;
}

/**
 * Parse the {@link KeyMeta} out of a zod metadata object written by {@link key}.
 *
 * @returns The metadata.
 * @throws ZodError when `meta` is not key metadata (a programming error).
 */
export function parseKeyMeta(meta: unknown): KeyMeta {
  const parsed = KeyMetaSchema.parse(meta ?? {});
  return {
    describe: parsed.describe,
    group: parsed.group,
    secret: parsed.secret,
    restartRequired: parsed.restartRequired,
    cliOnly: parsed.cliOnly,
    ...('default' in parsed && parsed.default !== undefined && { default: parsed.default }),
    ...(parsed.defaultText !== undefined && { defaultText: parsed.defaultText }),
    ...(parsed.derivedFrom !== undefined && { derivedFrom: parsed.derivedFrom }),
    ...(parsed.examples !== undefined && { examples: parsed.examples }),
    ...(parsed.grammar !== undefined && { grammar: parsed.grammar }),
  };
}

/**
 * Read the {@link KeyMeta} of a key schema built with {@link key}.
 *
 * @returns The metadata.
 * @throws ZodError when the schema carries no key metadata (a programming error).
 */
export function readKeyMeta(schema: z.ZodType): KeyMeta {
  return parseKeyMeta(schema.meta());
}

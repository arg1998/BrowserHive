/** @module app/config/layers — collect the raw layers (env, OTEL sub-source, CLI, file, programmatic overrides) into canonical keys with source and location (spec 08 §6 steps 1–2) */
import { dirname } from 'node:path';
import {
  CONFIG_KEYS,
  type ConfigKey,
  ENV_PREFIX,
  type EnvLookup,
  IDENTITY_ENV_VARS,
  isIdentityEnvVar,
  keyMeta,
  lookupKey,
  namesFor,
  type ProvenanceSource,
  reservedMessage,
  type ValueRef,
} from '@browserhive/contracts/config';
import type { TokenizedArgs } from './argv.ts';
import { type ConfigProblem, withSuggestion } from './failure.ts';
import { interpolateJson } from './interpolate.ts';
import type { JsonValue } from './json-parse.ts';
import { keyKind } from './kinds.ts';
import { emptyAfterMessage, refProblemMessage } from './ref-messages.ts';
import { suggest, suggestKey } from './suggest.ts';

/** One raw value for one key from one source, before parsing. */
export interface RawEntry {
  readonly key: ConfigKey;
  /** The text (env/CLI), JSON value (file) or typed value (overrides). */
  readonly raw: unknown;
  readonly source: ProvenanceSource;
  /** `--sessionLease`, `BROWSERHIVE_SESSION_LEASE`, `file:/path#sessionLease`, `options.sessionLease`. */
  readonly location: string;
  /** How the location reads in a message (`--sessionLease`, `'sessionLease' in /path`). */
  readonly display: string;
  /** Directory relative paths resolve against (config file dir for `file`, cwd otherwise). */
  readonly baseDir?: string;
  /** References the config-file value resolved (spec 08 §3.1); absent when none. */
  readonly refs?: readonly ValueRef[];
  /** The config-file value as written, before expansion; present only with `refs`. Internal: the merge drops it for redacted keys. */
  readonly template?: string;
  /** What each reference produced, parallel to `refs`. Internal: only for the secret registry. */
  readonly refValues?: readonly string[];
}

/** One collected layer: at most one raw entry per key, plus the problems found while collecting. */
export interface CollectedLayer {
  readonly entries: ReadonlyMap<ConfigKey, RawEntry>;
  readonly problems: readonly ConfigProblem[];
}

const EMPTY_HINT = 'Unset it or provide a value.';

/**
 * Collect every `BROWSERHIVE_*` variable (spec 08 §2): unknown names and reserved keys are
 * problems, empty values are usage errors (never "unset").
 *
 * @returns The env layer.
 */
export function collectEnvLayer(env: Readonly<Record<string, string | undefined>>): CollectedLayer {
  const entries = new Map<ConfigKey, RawEntry>();
  const problems: ConfigProblem[] = [];
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(ENV_PREFIX)) continue;
    const value = env[name];
    if (value === undefined) continue;
    // Per-process client identity, not configuration (08 §2.2, D-30).
    if (isIdentityEnvVar(name)) continue;
    const found = lookupKey('env', name);
    if (found.kind === 'unknown') {
      const keyed = suggestKey(name, 'env', CONFIG_KEYS);
      const removed = keyed.removed;
      // A misspelt identity variable deserves the same "did you mean" as a config key.
      const suggestions = removed
        ? keyed.suggestions
        : [...keyed.suggestions, ...suggest(name, IDENTITY_ENV_VARS)];
      const base = `unknown environment variable '${name}'.`;
      problems.push({
        code: 'CONFIG_UNKNOWN_KEY',
        source: 'env',
        location: name,
        message: removed ? `${base} ${UNSUPPORTED_HINT}` : withSuggestion(base, suggestions),
        suggestions,
      });
      continue;
    }
    if (found.kind === 'reserved') {
      problems.push({
        code: 'CONFIG_RESERVED_KEY',
        key: found.key,
        source: 'env',
        location: name,
        message: reservedMessage(found.key),
      });
      continue;
    }
    if (value === '') {
      problems.push({
        code: 'CONFIG_EMPTY_VALUE',
        key: found.key,
        source: 'env',
        location: name,
        message: `${name} is set but empty. ${EMPTY_HINT}`,
      });
      continue;
    }
    entries.set(found.key, {
      key: found.key,
      raw: value,
      source: 'env',
      location: name,
      display: name,
    });
  }
  return { entries, problems };
}

/** Hint for the unsupported `--admin-bind`, `--admin-port` and their env spellings (D-02). */
export const UNSUPPORTED_HINT =
  'This option is not supported: the dashboard shares --host and --port.';

/** Standard OTEL variables read as the `env(otel)` sub-source (spec 08 §5.3). */
export const OTEL_ENV_KEYS: Readonly<Record<string, ConfigKey>> = {
  OTEL_EXPORTER_OTLP_ENDPOINT: 'otelEndpoint',
  OTEL_EXPORTER_OTLP_HEADERS: 'otelHeaders',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'otelProtocol',
  OTEL_SERVICE_NAME: 'otelServiceName',
  OTEL_TRACES_SAMPLER_ARG: 'otelSampleRatio',
};

/**
 * Collect the standard `OTEL_*` variables below `BROWSERHIVE_*` env. Empty values are ignored
 * (they follow the OTel convention, not ours) and never produce problems here.
 *
 * @returns The `env(otel)` layer (no problems).
 */
export function collectOtelLayer(
  env: Readonly<Record<string, string | undefined>>,
): CollectedLayer {
  const entries = new Map<ConfigKey, RawEntry>();
  for (const [name, key] of Object.entries(OTEL_ENV_KEYS)) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    entries.set(key, { key, raw: value, source: 'env(otel)', location: name, display: name });
  }
  return { entries, problems: [] };
}

/**
 * Collect the CLI layer from tokenized argv: unknown flags, missing values, stray positionals
 * and reserved keys are problems; repeated list/map flags are joined with `,`; rightmost wins
 * for everything else.
 *
 * @returns The CLI layer.
 */
export function collectCliLayer(tokens: TokenizedArgs): CollectedLayer {
  const entries = new Map<ConfigKey, RawEntry>();
  const problems: ConfigProblem[] = [];
  for (const flag of [...tokens.unknown, ...tokens.shortFlags]) {
    const { suggestions, removed } = suggestKey(flag, 'cli', CONFIG_KEYS);
    const base = `unknown flag '${flag}'.`;
    const message = removed ? `${base} ${UNSUPPORTED_HINT}` : withSuggestion(base, suggestions);
    problems.push({
      code: 'CONFIG_UNKNOWN_KEY',
      source: 'cli',
      location: flag,
      message: `${message} Run 'browserhive --help'.`,
      suggestions,
    });
  }
  for (const flag of tokens.missingValue) {
    problems.push({
      code: 'CONFIG_USAGE',
      source: 'cli',
      location: flag,
      message: `${flag} requires a value.`,
    });
  }
  for (const positional of tokens.positionals) {
    problems.push({
      code: 'CONFIG_USAGE',
      source: 'cli',
      location: positional,
      message: `unexpected argument '${positional}'. Run 'browserhive --help'.`,
    });
  }
  for (const [name, values] of tokens.flags) {
    const flag = `--${name}`;
    const found = lookupKey('cli', flag);
    if (found.kind === 'unknown') continue; // already reported by the tokenizer's `known` predicate
    if (found.kind === 'reserved') {
      problems.push({
        code: 'CONFIG_RESERVED_KEY',
        key: found.key,
        source: 'cli',
        location: flag,
        message: reservedMessage(found.key),
      });
      continue;
    }
    const kind = keyKind(found.key);
    const raw = kind === 'list' || kind === 'map' ? values.join(',') : (values.at(-1) ?? '');
    if (raw === '') {
      problems.push({
        code: 'CONFIG_EMPTY_VALUE',
        key: found.key,
        source: 'cli',
        location: flag,
        message: `${flag} is set but empty. ${EMPTY_HINT}`,
      });
      continue;
    }
    entries.set(found.key, { key: found.key, raw, source: 'cli', location: flag, display: flag });
  }
  return { entries, problems };
}

/** What a value was written as: the string itself, or compact JSON for arrays and objects. */
function templateOf(raw: JsonValue): string {
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

/**
 * Collect the config-file layer from its parsed JSON object (spec 08 §3): `$schema` is
 * ignored, unknown keys get "did you mean", reserved keys and `cliOnly` keys are rejected,
 * empty strings are usage errors. `{env:NAME}` references in string values are expanded against
 * `lookup` (§3.1), and a value empty only after that is a usage error too. Relative paths later
 * resolve against the file's directory.
 *
 * @returns The file layer.
 */
export function collectFileLayer(
  json: { readonly [key: string]: JsonValue },
  filePath: string,
  lookup: EnvLookup = () => undefined,
): CollectedLayer {
  const entries = new Map<ConfigKey, RawEntry>();
  const problems: ConfigProblem[] = [];
  const baseDir = dirname(filePath);
  for (const [name, raw] of Object.entries(json)) {
    if (name === '$schema') continue;
    const location = `file:${filePath}#${name}`;
    const found = lookupKey('json', name);
    if (found.kind === 'unknown') {
      const { suggestions, removed } = suggestKey(name, 'json', CONFIG_KEYS);
      const base = `unknown key '${name}' in ${filePath}.`;
      problems.push({
        code: 'CONFIG_UNKNOWN_KEY',
        source: 'file',
        location,
        message: removed ? `${base} ${UNSUPPORTED_HINT}` : withSuggestion(base, suggestions),
        suggestions,
      });
      continue;
    }
    if (found.kind === 'reserved') {
      problems.push({
        code: 'CONFIG_RESERVED_KEY',
        key: found.key,
        source: 'file',
        location,
        message: reservedMessage(found.key),
      });
      continue;
    }
    const key = found.key;
    if (keyMeta(key).cliOnly) {
      problems.push({
        code: 'CONFIG_USAGE',
        key,
        source: 'file',
        location,
        message: `'${key}' cannot be set from a config file (use ${namesFor(key).cli} or ${namesFor(key).env}).`,
      });
      continue;
    }
    if (raw === '') {
      problems.push({
        code: 'CONFIG_EMPTY_VALUE',
        key,
        source: 'file',
        location,
        message: `'${key}' in ${filePath} is set but empty. ${EMPTY_HINT}`,
      });
      continue;
    }
    const expanded = interpolateJson(raw, lookup);
    if (expanded.problems.length > 0) {
      const secret = keyMeta(key).secret;
      for (const { problem } of expanded.problems) {
        problems.push({
          code: 'CONFIG_REF_UNRESOLVED',
          key,
          source: 'file',
          location,
          message: refProblemMessage(key, filePath, problem, secret),
        });
      }
      continue;
    }
    const refs = expanded.refs;
    if (refs.length > 0 && expanded.value === '') {
      problems.push({
        code: 'CONFIG_EMPTY_VALUE',
        key,
        source: 'file',
        location,
        message: emptyAfterMessage(key, filePath, refs),
      });
      continue;
    }
    entries.set(key, {
      key,
      raw: expanded.value,
      source: 'file',
      location,
      display: `'${key}' in ${filePath}`,
      baseDir,
      ...(refs.length > 0 && { refs, template: templateOf(raw), refValues: expanded.values }),
    });
  }
  return { entries, problems };
}

/**
 * Programmatic overrides (spec 08 §9): the typed camelCase keys in either canonical form
 * (`7_200_000`) or grammar form (`'2h'`); every value is parsed by the key's schema.
 */
export type ConfigOverrides = { readonly [K in ConfigKey]?: unknown };

/**
 * Collect programmatic overrides (`createServer` options, spec 08 §9): typed values with
 * provenance `cli` and location `options.<key>`. Keys with `undefined` values are ignored.
 *
 * @returns The overrides layer (no problems; values are parsed like any other source).
 */
export function collectOverridesLayer(overrides: ConfigOverrides): CollectedLayer {
  const entries = new Map<ConfigKey, RawEntry>();
  for (const key of CONFIG_KEYS) {
    const raw: unknown = overrides[key];
    if (raw === undefined) continue;
    const location = `options.${key}`;
    entries.set(key, { key, raw, source: 'cli', location, display: location });
  }
  return { entries, problems: [] };
}

/** @module app/config/kinds — value grammar of each key (from the parser's grammar text) and canonical rendering of resolved values (spec 08 §1, §2.1) */
import {
  type ConfigKey,
  formatBytes,
  formatDuration,
  formatLevelSpec,
  keyMeta,
  zLevelSpec,
} from '@browserhive/contracts/config';

/** The value grammar a key uses; drives tokenizing (booleans), list joining, path resolution and rendering. */
export type KeyKind =
  | 'boolean'
  | 'duration'
  | 'bytes'
  | 'list'
  | 'map'
  | 'path'
  | 'levelSpec'
  | 'scalar';

/** Keys whose values are file system paths (resolved against cwd or the config file's directory). */
export const PATH_KEYS: readonly ConfigKey[] = ['config', 'dataDir', 'blocklist'];

const KIND_CACHE = new Map<ConfigKey, KeyKind>();

/**
 * Grammar kind of a key, detected from the parser's grammar text (`a boolean: …`, `a duration …`,
 * `a size …`, `a comma-separated map …`, `a comma-separated …`, `a level spec …`, path keys).
 *
 * @returns The key's kind; `scalar` for enums, numbers, hosts, URLs and strings.
 */
export function keyKind(key: ConfigKey): KeyKind {
  const cached = KIND_CACHE.get(key);
  if (cached !== undefined) return cached;
  const grammar = keyMeta(key).grammar ?? '';
  let kind: KeyKind = 'scalar';
  if (PATH_KEYS.includes(key)) kind = 'path';
  else if (grammar.startsWith('a boolean')) kind = 'boolean';
  else if (grammar.startsWith('a duration')) kind = 'duration';
  else if (grammar.startsWith('a size')) kind = 'bytes';
  else if (grammar.startsWith('a comma-separated map')) kind = 'map';
  else if (grammar.startsWith('a comma-separated')) kind = 'list';
  else if (grammar.startsWith('a level spec')) kind = 'levelSpec';
  KIND_CACHE.set(key, kind);
  return kind;
}

/** Placeholder rendered for secret values (spec 08 §1). */
export const REDACTED_TEXT = '<redacted>';

/**
 * Canonical text of a resolved value: `2h` for durations, `1GiB` for bytes, `a,b` for lists,
 * `k=v,k2=v2` for maps, `info,sessions=debug` for level specs, `true`/`false`, plain text otherwise.
 * Secrets are never rendered here; callers apply {@link REDACTED_TEXT} via `keyMeta(key).secret`.
 *
 * @returns The rendering the parser would accept back.
 */
export function renderValue(key: ConfigKey, value: unknown): string {
  if (value === undefined) return '';
  switch (keyKind(key)) {
    case 'duration':
      return typeof value === 'number' ? formatDuration(value) : String(value);
    case 'bytes':
      return typeof value === 'number' ? formatBytes(value) : String(value);
    case 'levelSpec': {
      const spec = zLevelSpec.safeParse(value);
      return spec.success ? formatLevelSpec(spec.data) : String(value);
    }
    case 'list':
      return Array.isArray(value) ? value.map(String).join(',') : String(value);
    case 'map':
      return typeof value === 'object' && value !== null
        ? Object.entries(value)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')
        : String(value);
    case 'boolean':
    case 'path':
    case 'scalar':
      return typeof value === 'string' ? value : JSON.stringify(value);
    default:
      return String(value);
  }
}

/**
 * Text of a raw supplied value for error messages (`'2 hours'`); JSON non-strings are stringified.
 *
 * @returns The quoted raw text.
 */
export function quoteRaw(raw: unknown): string {
  return typeof raw === 'string' ? `'${raw}'` : `'${JSON.stringify(raw)}'`;
}

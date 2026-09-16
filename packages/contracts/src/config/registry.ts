/** @module contracts/config/registry — key registry: names in the three sources, metadata lookup, reserved keys (spec 08 §2, §5.4) */
import { type KeyMeta, readKeyMeta } from './key.ts';
import { CONFIG_SHAPE, type ConfigKey } from './shape.ts';

/** Prefix of every environment variable. */
export const ENV_PREFIX = 'BROWSERHIVE_';

/** The external spellings of one key (spec 08 §2). */
export interface KeyNames {
  /** `BROWSERHIVE_<SCREAMING_SNAKE>` */
  readonly env: string;
  /** `--camelCase` */
  readonly cli: string;
  /** `camelCase` */
  readonly json: string;
}

/**
 * Reserved key names (spec 08 §5.4): registered so typos and premature use fail fast with the
 * reserved-key message. They have no type, default or behaviour.
 */
export const RESERVED_CONFIG_KEYS = [
  'proxy',
  'proxies',
  'proxyRotation',
  'notifications',
  'notificationChannels',
  'otelMetricsInterval',
  'captchaSolver',
  'extensions',
  'profiles',
  'resourceBudget',
  'tenant',
] as const;
/** Union of {@link RESERVED_CONFIG_KEYS}. */
export type ReservedConfigKey = (typeof RESERVED_CONFIG_KEYS)[number];

/** Reserved enum members per key (spec 08 §5.4); the parsers reject them with the reserved message. */
export const RESERVED_ENUM_MEMBERS: Readonly<Partial<Record<ConfigKey, readonly string[]>>> = {
  vault: ['local', 'onepassword', 'http'],
  captcha: ['solver'],
  persistence: ['blueprint'],
  transport: ['ws'],
};

/** Unsupported spellings recognised by the config resolver and answered with an unknown-key hint, mapped to the canonical key (`null`: no equivalent) (spec 08 §5.5). */
export const KEY_ALIASES: Readonly<Record<string, ConfigKey | null>> = {
  '--admin-bind': null,
  '--admin-port': null,
  '--pretty-logs': 'logFormat',
  '--log-pretty': 'logFormat',
  BROWSERHIVE_LOG_PRETTY: 'logFormat',
  BROWSERHIVE_DISABLE_PATCHRIGHT: 'stealthDriver',
  BROWSERHIVE_ADMIN_BIND: null,
  BROWSERHIVE_ADMIN_PORT: null,
};

function isConfigKey(value: string): value is ConfigKey {
  return Object.hasOwn(CONFIG_SHAPE, value);
}

/** Every canonical key in help order. */
export const CONFIG_KEYS: readonly ConfigKey[] = Object.freeze(
  Object.keys(CONFIG_SHAPE).filter(isConfigKey),
);

/**
 * Environment variable name of a canonical key: `BROWSERHIVE_` + camelCase split on case boundaries,
 * upper-cased. Acronyms are words (`otelEndpoint` → `OTEL_ENDPOINT`), so the mapping is reversible.
 *
 * @returns The env var name.
 */
export function envNameOf(key: string): string {
  return `${ENV_PREFIX}${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

/**
 * The three external spellings of a key (canonical, reserved or any camelCase name).
 *
 * @returns `{ env, cli, json }`.
 */
export function namesFor(key: ConfigKey | ReservedConfigKey | string): KeyNames {
  return { env: envNameOf(key), cli: `--${key}`, json: key };
}

const KEY_BY_ENV: ReadonlyMap<string, ConfigKey> = new Map(
  CONFIG_KEYS.map((key) => [envNameOf(key), key]),
);
const RESERVED_BY_ENV: ReadonlyMap<string, ReservedConfigKey> = new Map(
  RESERVED_CONFIG_KEYS.map((key) => [envNameOf(key), key]),
);

/** Result of resolving an external spelling back to a key. */
export type KeyLookup =
  | { readonly kind: 'key'; readonly key: ConfigKey }
  | { readonly kind: 'reserved'; readonly key: ReservedConfigKey }
  | { readonly kind: 'unknown' };

function isReservedKey(value: string): value is ReservedConfigKey {
  return (RESERVED_CONFIG_KEYS as readonly string[]).includes(value);
}

/**
 * Map an external spelling (env var name, `--flag` or JSON key) to its canonical key. Matching is
 * case-sensitive; kebab-case flags are unknown by design (spec 08 §2).
 *
 * @returns The lookup result.
 */
export function lookupKey(source: 'env' | 'cli' | 'json', name: string): KeyLookup {
  if (source === 'env') {
    const key = KEY_BY_ENV.get(name);
    if (key !== undefined) return { kind: 'key', key };
    const reserved = RESERVED_BY_ENV.get(name);
    return reserved === undefined ? { kind: 'unknown' } : { kind: 'reserved', key: reserved };
  }
  const bare = source === 'cli' ? (name.startsWith('--') ? name.slice(2) : '') : name;
  if (isConfigKey(bare)) return { kind: 'key', key: bare };
  if (isReservedKey(bare)) return { kind: 'reserved', key: bare };
  return { kind: 'unknown' };
}

const META_CACHE = new Map<ConfigKey, KeyMeta>();

/**
 * Metadata of a key (description, group, default, secret, restartRequired…).
 *
 * @returns The key's {@link KeyMeta}.
 */
export function keyMeta(key: ConfigKey): KeyMeta {
  const cached = META_CACHE.get(key);
  if (cached !== undefined) return cached;
  const meta = readKeyMeta(CONFIG_SHAPE[key]);
  META_CACHE.set(key, meta);
  return meta;
}

/**
 * Keys of one help group, in registry order.
 *
 * @returns The keys whose `group` matches.
 */
export function keysInGroup(group: KeyMeta['group']): readonly ConfigKey[] {
  return CONFIG_KEYS.filter((key) => keyMeta(key).group === group);
}

/**
 * Keys whose values are rendered `<redacted>`.
 *
 * @returns The secret keys.
 */
export function secretKeys(): readonly ConfigKey[] {
  return CONFIG_KEYS.filter((key) => keyMeta(key).secret);
}

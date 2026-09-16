/** @module app/config/merge — merge parsed layers by precedence with provenance and shadow lists, then fill defaults and derived values in dependency order (spec 08 §6 step 4) */
import {
  CONFIG_KEYS,
  type ConfigKey,
  type ExplicitKeys,
  type KeyProvenance,
  keyMeta,
  type Provenance,
  type SuppliedValue,
} from '@browserhive/contracts/config';
import type { HostEnvironment } from '../../ports/host-environment.ts';
import { deriveMaxSessions, osDefaultDataDir } from './data-dir.ts';
import { REDACTED_TEXT, renderValue } from './kinds.ts';
import type { ParsedEntry } from './parse.ts';

/** One parsed layer: at most one entry per key. */
export type ParsedLayer = ReadonlyMap<ConfigKey, ParsedEntry>;

/** Result of {@link mergeLayers}. */
export interface MergedConfig {
  /** Canonical value per key (`undefined` for unset optional keys). */
  readonly values: Readonly<Record<ConfigKey, unknown>>;
  readonly provenance: Provenance;
  /** Keys supplied by env, file or CLI (not `env(otel)`, defaults or derived values). */
  readonly explicit: ExplicitKeys;
}

/**
 * Render a value for provenance: secrets become `<redacted>` on both sides of a shadow line.
 *
 * @returns The canonical text, or `<redacted>`.
 */
export function renderForProvenance(key: ConfigKey, value: unknown): string {
  return keyMeta(key).secret ? REDACTED_TEXT : renderValue(key, value);
}

/** Derivation order (spec 08 §6): `stealth → fingerprint`, `admin → trace`, `hostMemory → maxSessions`, `platform → dataDir`. */
const DERIVED_ORDER: readonly ConfigKey[] = ['fingerprint', 'trace', 'maxSessions', 'dataDir'];

function deriveValue(
  key: ConfigKey,
  values: Record<ConfigKey, unknown>,
  host: HostEnvironment,
): unknown {
  switch (key) {
    case 'fingerprint':
      return values['stealth'] === 'max';
    case 'trace':
      return values['admin'] === true;
    case 'maxSessions':
      return deriveMaxSessions(host.totalMemoryBytes);
    case 'dataDir':
      return osDefaultDataDir(host);
    default:
      return undefined;
  }
}

/**
 * Merge parsed layers given highest precedence first (`[cli, file, env, env(otel)]`): the first
 * layer supplying a key wins, the others are recorded as shadowed; unsupplied keys take the
 * registry default or a derived value.
 *
 * @returns Values, provenance and the explicit key set.
 */
export function mergeLayers(layers: readonly ParsedLayer[], host: HostEnvironment): MergedConfig {
  const values: Record<ConfigKey, unknown> = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, undefined]),
  ) as Record<ConfigKey, unknown>; // every key is assigned below
  const provenance: Partial<Record<ConfigKey, KeyProvenance>> = {};
  const explicit = new Set<ConfigKey>();

  for (const key of CONFIG_KEYS) {
    const supplied = layers.flatMap((layer) => {
      const entry = layer.get(key);
      return entry === undefined ? [] : [entry];
    });
    const winner = supplied[0];
    if (winner !== undefined) {
      values[key] = winner.value;
      if (winner.source === 'env' || winner.source === 'file' || winner.source === 'cli') {
        explicit.add(key);
      }
      const shadowed: SuppliedValue[] = supplied.slice(1).map((entry) => ({
        source: entry.source,
        raw: renderForProvenance(key, entry.value),
        location: entry.location,
      }));
      provenance[key] = {
        key,
        source: winner.source,
        rendered: renderForProvenance(key, winner.value),
        location: winner.location,
        shadowed,
      };
      continue;
    }
    const meta = keyMeta(key);
    if (meta.derivedFrom !== undefined) continue; // filled below, in dependency order
    values[key] = meta.default;
    provenance[key] = {
      key,
      source: 'default',
      rendered: meta.default === undefined ? '' : renderForProvenance(key, meta.default),
      shadowed: [],
    };
  }

  for (const key of DERIVED_ORDER) {
    if (provenance[key] !== undefined) continue;
    const meta = keyMeta(key);
    const value = deriveValue(key, values, host);
    values[key] = value;
    provenance[key] = {
      key,
      source: 'derived',
      rendered: renderForProvenance(key, value),
      ...(meta.derivedFrom !== undefined && { derivedFrom: meta.derivedFrom }),
      shadowed: [],
    };
  }

  return {
    values,
    provenance: provenance as Provenance, // every key was assigned in the two loops above
    explicit,
  };
}

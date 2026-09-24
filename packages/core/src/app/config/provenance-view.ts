/** @module app/config/provenance-view — `config show` rows, the `GET /api/v1/system/config` view (secrets → `{ redacted: true }`), shadow lines and the banner's source summary (spec 08 §1, §7.1, §8) */
import {
  CONFIG_KEYS,
  type ConfigKey,
  type DerivedSource,
  formatShadowLine,
  keyMeta,
  type Provenance,
  type ProvenanceSource,
  type ServerConfig,
  type ShadowLine,
  shadowLabel,
  sourceWithRefs,
  type ValueRef,
  viaRefs,
} from '@browserhive/contracts/config';
import { REDACTED_TEXT } from './kinds.ts';

/** One row of the `browserhive config show` table. */
export interface ConfigShowRow {
  readonly key: ConfigKey;
  /** Rendered value (`<redacted>` for secrets, `—` when unset). */
  readonly value: string;
  /** Source label (`config-file` for the file source, `config-file via $OTLP_HOST` with references). */
  readonly source: string;
  /** Shadowed sources as `label=value[ via $NAME]`, highest precedence first. */
  readonly shadowed: readonly string[];
}

/** Marker the API returns in place of a secret value. */
export interface RedactedValue {
  readonly redacted: true;
}

/** One entry of the API / `config show --json` view. */
export interface ConfigViewEntry {
  readonly value: unknown | RedactedValue;
  readonly source: ProvenanceSource;
  readonly derivedFrom?: DerivedSource;
  readonly location?: string;
  /** References the winning config-file value resolved (spec 08 §3.1). */
  readonly refs?: readonly ValueRef[];
  /** The winning config-file value as written; never present when the value is redacted. */
  readonly template?: string;
  readonly shadowed: ReadonlyArray<{
    readonly source: ProvenanceSource;
    readonly value: string;
    readonly location: string;
    readonly refs?: readonly ValueRef[];
  }>;
  readonly restartRequired: boolean;
}

/** The `ServerConfigView`: every key with its typed value (secrets replaced) and provenance. */
export type ConfigView = Readonly<Record<ConfigKey, ConfigViewEntry>>;

/**
 * Rows for `browserhive config show`, in registry order.
 *
 * @returns One row per key.
 */
export function configShowRows(provenance: Provenance): readonly ConfigShowRow[] {
  return CONFIG_KEYS.map((key) => {
    const entry = provenance[key];
    return {
      key,
      value: entry.rendered === '' ? '—' : entry.rendered,
      source:
        entry.source === 'derived'
          ? `derived (${entry.derivedFrom ?? ''})`
          : sourceWithRefs(entry.source, entry.refs),
      shadowed: entry.shadowed.map(
        (value) => `${shadowLabel(value.source)}=${value.raw}${viaRefs(value.refs)}`,
      ),
    };
  });
}

/**
 * The view served by `GET /api/v1/system/config` and printed by `config show --json`: typed
 * values with secrets replaced by `{ redacted: true }` (keys flagged secret, and keys a
 * credential-looking reference name made sensitive for this run), plus the provenance model of
 * spec 08 §1 with the references of §3.1.
 *
 * @returns The view keyed by canonical name.
 */
export function configView(config: Readonly<ServerConfig>, provenance: Provenance): ConfigView {
  const view: Partial<Record<ConfigKey, ConfigViewEntry>> = {};
  for (const key of CONFIG_KEYS) {
    const entry = provenance[key];
    const meta = keyMeta(key);
    const raw: unknown = config[key];
    const redacted = meta.secret || entry.sensitive === true;
    const value: unknown = redacted && raw !== undefined ? { redacted: true } : raw;
    view[key] = {
      value,
      source: entry.source,
      ...(entry.derivedFrom !== undefined && { derivedFrom: entry.derivedFrom }),
      ...(entry.location !== undefined && { location: entry.location }),
      ...(entry.refs !== undefined && { refs: entry.refs }),
      ...(entry.template !== undefined && !redacted && { template: entry.template }),
      shadowed: entry.shadowed.map((s) => ({
        source: s.source,
        value: s.raw,
        location: s.location,
        ...(s.refs !== undefined && { refs: s.refs }),
      })),
      restartRequired: meta.restartRequired,
    };
  }
  return view as ConfigView; // every key was assigned in the loop
}

/**
 * The `config: <key>=<value> (<source>) shadows …` lines for every key supplied by more than one
 * source, in registry order. Secrets are already `<redacted>` in the provenance.
 *
 * @returns The shadow lines.
 */
export function shadowLines(provenance: Provenance): readonly ShadowLine[] {
  return CONFIG_KEYS.filter((key) => provenance[key].shadowed.length > 0).map((key) => ({
    key,
    text: formatShadowLine(provenance[key], (value) => value.raw),
  }));
}

/**
 * The banner's `Config` line body (spec 08 §8): `env:2  file:/path:9  cli:1`, counting keys each
 * source supplied (winning or shadowed). Sources with no keys are omitted; `none` when empty.
 *
 * @returns The summary text.
 */
export function configSourceSummary(
  provenance: Provenance,
  configFilePath: string | undefined,
): string {
  const counts = new Map<ProvenanceSource, number>();
  for (const key of CONFIG_KEYS) {
    const entry = provenance[key];
    for (const source of [entry.source, ...entry.shadowed.map((s) => s.source)]) {
      if (source === 'default' || source === 'derived') continue;
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  const parts: string[] = [];
  const order: readonly ProvenanceSource[] = ['env', 'env(otel)', 'file', 'cli'];
  for (const source of order) {
    const count = counts.get(source);
    if (count === undefined) continue;
    const label =
      source === 'file' && configFilePath !== undefined ? `file:${configFilePath}` : source;
    parts.push(`${label}:${count}`);
  }
  return parts.length === 0 ? 'none' : parts.join('  ');
}

/** Text used for secret values in every human rendering. */
export const REDACTED = REDACTED_TEXT;

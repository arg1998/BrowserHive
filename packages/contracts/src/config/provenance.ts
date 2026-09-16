/** @module contracts/config/provenance — per-key provenance records produced by the resolver (spec 08 §1, §6) */
import type { ProvenanceSource } from '../enums/provenance-source.ts';
import type { DerivedSource } from './key.ts';
import type { ConfigKey } from './shape.ts';

/** One supplied value from one source, as the resolver saw it. */
export interface SuppliedValue {
  /** Which source supplied it. */
  readonly source: ProvenanceSource;
  /** The original text (or JSON value rendering) for shadow lines and `config show`. */
  readonly raw: string;
  /** Where exactly (`--sessionLease`, `BROWSERHIVE_SESSION_LEASE`, `file:/path#sessionLease`). */
  readonly location: string;
}

/** Provenance of one resolved key. */
export interface KeyProvenance {
  /** The canonical key. */
  readonly key: ConfigKey;
  /** The winning source. */
  readonly source: ProvenanceSource;
  /** The winning value in canonical text (secrets: `<redacted>`). */
  readonly rendered: string;
  /** For `derived`: the input the default was computed from. */
  readonly derivedFrom?: DerivedSource;
  /** Where the winning value came from (absent for defaults and derived values). */
  readonly location?: string;
  /** Lower-precedence sources that also supplied the key, highest first. */
  readonly shadowed: readonly SuppliedValue[];
}

/** Provenance of every key, keyed by canonical name; returned next to the frozen config. */
export type Provenance = Readonly<Record<ConfigKey, KeyProvenance>>;

/** One `config: <key>=<value> (<source>) shadows …` line the resolver logs at startup. */
export interface ShadowLine {
  readonly key: ConfigKey;
  readonly text: string;
}

/** Source label used in shadow lines (`config-file` for the file source, spec 08 §1). */
export function shadowLabel(source: ProvenanceSource): string {
  return source === 'file' ? 'config-file' : source;
}

/**
 * Render the startup shadow line for a key with more than one supplier.
 *
 * @returns `config: maxSessions=8 (cli) shadows config-file=4, env=2`.
 */
export function formatShadowLine(
  provenance: KeyProvenance,
  renderShadowed: (value: SuppliedValue) => string,
): string {
  const shadowed = provenance.shadowed
    .map((value) => `${shadowLabel(value.source)}=${renderShadowed(value)}`)
    .join(', ');
  return `config: ${provenance.key}=${provenance.rendered} (${shadowLabel(provenance.source)}) shadows ${shadowed}`;
}

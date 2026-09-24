/** @module contracts/config/provenance — per-key provenance records produced by the resolver (spec 08 §1, §6) */
import type { ProvenanceSource } from '../enums/provenance-source.ts';
import type { DerivedSource } from './key.ts';
import { formatRefNames, type ValueRef } from './refs.ts';
import type { ConfigKey } from './shape.ts';

/** One supplied value from one source, as the resolver saw it. */
export interface SuppliedValue {
  /** Which source supplied it. */
  readonly source: ProvenanceSource;
  /** The original text (or JSON value rendering) for shadow lines and `config show`. */
  readonly raw: string;
  /** Where exactly (`--sessionLease`, `BROWSERHIVE_SESSION_LEASE`, `file:/path#sessionLease`). */
  readonly location: string;
  /** References a config-file value resolved, in source order (spec 08 §3.1). Absent when none. */
  readonly refs?: readonly ValueRef[];
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
  /** References the winning config-file value resolved, in source order (spec 08 §3.1). Absent when none. */
  readonly refs?: readonly ValueRef[];
  /**
   * The winning config-file value as written, references unexpanded (`http://{env:OTLP_HOST}:4318`;
   * arrays and objects as compact JSON). Never present on a redacted key: there the literal text
   * around a reference may itself be secret.
   */
  readonly template?: string;
  /**
   * `true` when the key is not flagged `secret` but is redacted for this run, because a reference
   * with a credential-looking name supplied one of its values (spec 08 §3.1, 10 §9).
   */
  readonly sensitive?: true;
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
 * ` via $A, $B (default)` for a value that came through references, else `''` (spec 08 §1).
 *
 * @returns The suffix, with its leading space.
 */
export function viaRefs(refs: readonly ValueRef[] | undefined): string {
  const names = formatRefNames(refs);
  return names === '' ? '' : ` via ${names}`;
}

/**
 * Source label of a winning value with its references: `config-file via $OTLP_HOST`.
 *
 * @returns The label.
 */
export function sourceWithRefs(source: ProvenanceSource, refs?: readonly ValueRef[]): string {
  return `${shadowLabel(source)}${viaRefs(refs)}`;
}

/**
 * Render the startup shadow line for a key with more than one supplier.
 *
 * @returns `config: maxSessions=8 (cli) shadows config-file=4, env=2`; a value that came through
 * references carries ` via $NAME` after its source or value.
 */
export function formatShadowLine(
  provenance: KeyProvenance,
  renderShadowed: (value: SuppliedValue) => string,
): string {
  const shadowed = provenance.shadowed
    .map((value) => `${shadowLabel(value.source)}=${renderShadowed(value)}${viaRefs(value.refs)}`)
    .join(', ');
  return `config: ${provenance.key}=${provenance.rendered} (${sourceWithRefs(provenance.source, provenance.refs)}) shadows ${shadowed}`;
}

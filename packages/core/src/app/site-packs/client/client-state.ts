/** @module app/site-packs/client/client-state — what the registry client keeps in the `meta` table (spec 13 §9.9): the rollback floors `site_packs.keys_version` and `site_packs.index_version` (only ever raised, except by a newer root-signed `keys.json`'s `index_floor`), and `site_packs.client`: the last checks, the hashes of the held files, where the held index came from and the revocations already handled. A value that does not parse reads as absent. */

import type { SitePackCheckOutcome } from '@browserhive/contracts/http';
import type { SitePackMetaRepository } from '../../../ports/persistence/site-packs.ts';

/** The rollback floors (spec 13 §10.3). */
export interface RegistryFloorsRecord {
  readonly keysVersion: number | null;
  readonly indexVersion: number | null;
}

/** `site_packs.client`. */
export interface ClientRecord {
  readonly last_check_at: number | null;
  readonly last_ok_at: number | null;
  readonly last_outcome: SitePackCheckOutcome | null;
  readonly last_error: { readonly code: string; readonly message: string } | null;
  /** Consecutive failed checks. */
  readonly failures: number;
  /** SHA-256 of the held `index.json` and `keys.json` (a held file with another hash is ignored). */
  readonly index_sha256: string | null;
  readonly keys_sha256: string | null;
  /** The online key whose signature of the held index verified. */
  readonly signed_by: string | null;
  readonly index_origin: 'registry' | 'import' | 'local' | null;
  /** The imported folder's name or the local layout's path. */
  readonly origin_name: string | null;
  /** The registry's `Date` minus this clock at the last check, when more than 5 minutes. */
  readonly clock_skew_ms?: number;
  /** A newer `keys.json`'s `index_floor` not consumed yet (honoured with the next accepted index). */
  readonly pending_index_floor: number | null;
  /**
   * Auto-update per pack (D-87, review #100 N2/N3): the content the last operator decision put in
   * force (every bound is measured against it, so small steps cannot compound) and whether an
   * operator's revert or reject paused auto-update.
   */
  readonly auto: Readonly<Record<string, AutoPolicy>>;
  /** `<pack>@<version>:<sha256>` revocations already applied (never applied twice). */
  readonly revocations: readonly string[];
}

/** Auto-update's baseline and pause for one pack. */
export interface AutoPolicy {
  readonly baseline_sha256: string | null;
  readonly baseline_source: 'bundled' | 'remote' | 'import' | 'local' | null;
  readonly paused: boolean;
}

const SOURCES: ReadonlySet<string> = new Set(['bundled', 'remote', 'import', 'local']);

function autoOf(value: unknown): Record<string, AutoPolicy> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, AutoPolicy> = {};
  for (const [packId, raw] of Object.entries(value as Record<string, unknown>).slice(0, 1_000)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const source = strOrNull(r['baseline_source']);
    out[packId] = {
      baseline_sha256: strOrNull(r['baseline_sha256']),
      baseline_source:
        source !== null && SOURCES.has(source) ? (source as AutoPolicy['baseline_source']) : null,
      paused: r['paused'] === true,
    };
  }
  return out;
}

/** A fresh record. */
export const EMPTY_CLIENT: ClientRecord = {
  last_check_at: null,
  last_ok_at: null,
  last_outcome: null,
  last_error: null,
  failures: 0,
  index_sha256: null,
  keys_sha256: null,
  signed_by: null,
  index_origin: null,
  origin_name: null,
  pending_index_floor: null,
  auto: {},
  revocations: [],
};

const OUTCOMES: ReadonlySet<string> = new Set(['updated', 'not_modified', 'failed', 'disabled']);
const ORIGINS: ReadonlySet<string> = new Set(['registry', 'import', 'local']);

function intOrNull(text: string | null): number | null {
  if (text === null || !/^\d{1,16}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Reads the floors. */
export async function readFloors(meta: SitePackMetaRepository): Promise<RegistryFloorsRecord> {
  return {
    keysVersion: intOrNull(await meta.get('site_packs.keys_version')),
    indexVersion: intOrNull(await meta.get('site_packs.index_version')),
  };
}

/** Writes the floors (both, as decided by the caller). */
export async function writeFloors(
  meta: SitePackMetaRepository,
  floors: { readonly keysVersion: number; readonly indexVersion: number },
): Promise<void> {
  await meta.set('site_packs.keys_version', String(floors.keysVersion));
  await meta.set('site_packs.index_version', String(floors.indexVersion));
}

/** Reads `site_packs.client`. */
export async function readClient(meta: SitePackMetaRepository): Promise<ClientRecord> {
  const text = await meta.get('site_packs.client');
  if (text === null) return EMPTY_CLIENT;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_CLIENT;
  }
  if (typeof raw !== 'object' || raw === null) return EMPTY_CLIENT;
  const r = raw as Record<string, unknown>;
  const error = r['last_error'];
  const outcome = strOrNull(r['last_outcome']);
  const origin = strOrNull(r['index_origin']);
  const skew = numOrNull(r['clock_skew_ms']);
  return {
    last_check_at: numOrNull(r['last_check_at']),
    last_ok_at: numOrNull(r['last_ok_at']),
    last_outcome:
      outcome !== null && OUTCOMES.has(outcome) ? (outcome as SitePackCheckOutcome) : null,
    last_error:
      typeof error === 'object' && error !== null
        ? {
            code: strOrNull((error as Record<string, unknown>)['code']) ?? 'UNKNOWN',
            message: strOrNull((error as Record<string, unknown>)['message']) ?? '',
          }
        : null,
    failures: Math.max(0, Math.trunc(numOrNull(r['failures']) ?? 0)),
    index_sha256: strOrNull(r['index_sha256']),
    keys_sha256: strOrNull(r['keys_sha256']),
    signed_by: strOrNull(r['signed_by']),
    index_origin:
      origin !== null && ORIGINS.has(origin) ? (origin as ClientRecord['index_origin']) : null,
    origin_name: strOrNull(r['origin_name']),
    pending_index_floor: numOrNull(r['pending_index_floor']),
    auto: autoOf(r['auto']),
    ...(skew !== null && { clock_skew_ms: Math.trunc(skew) }),
    revocations: Array.isArray(r['revocations'])
      ? r['revocations'].filter((x): x is string => typeof x === 'string').slice(0, 5_000)
      : [],
  };
}

/** Writes `site_packs.client`. */
export async function writeClient(
  meta: SitePackMetaRepository,
  record: ClientRecord,
): Promise<void> {
  await meta.set('site_packs.client', JSON.stringify(record));
}

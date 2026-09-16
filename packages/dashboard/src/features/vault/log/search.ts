/** @module features/vault/log/search — `/vault/log` search params (result, origin_check, evaluate, session, entry, window, table params) and the cache-key / wire-query rules (spec 04 §12.8) */

import { OriginCheck, VaultAccessResult, type VaultLogQuery } from '@browserhive/contracts/http';
import { SESSION_ID_RE } from '@browserhive/contracts/ids';
import { z } from 'zod';
import { csvParam, tableSearchSchema } from '@/lib/search/table.ts';
import { rangeParam, rangeWindow } from '@/lib/search/time-range.ts';

/** Sort keys in the URL. */
export const LOG_SORT_KEYS = ['time', 'entry', 'result', 'session'] as const;
/** URL sort key. */
export type LogSortKey = (typeof LOG_SORT_KEYS)[number];

const WIRE_SORT: { readonly [K in LogSortKey]: 'ts' | 'entry_name' | 'result' | 'session' } = {
  time: 'ts',
  entry: 'entry_name',
  result: 'result',
  session: 'session',
};

const epochParam = z.coerce.number().int().nonnegative().optional().catch(undefined);

/** Search schema. */
export const vaultLogSearch = tableSearchSchema(LOG_SORT_KEYS).extend({
  result: csvParam(VaultAccessResult),
  origin_check: csvParam(OriginCheck),
  evaluate: z.enum(['on', 'off']).optional().catch(undefined),
  session: z.string().regex(SESSION_ID_RE).optional().catch(undefined),
  entry: z.string().trim().min(1).max(200).optional().catch(undefined),
  range: rangeParam,
  since: epochParam,
  until: epochParam,
});
/** Parsed search. */
export type VaultLogSearch = z.infer<typeof vaultLogSearch>;
/** Defaults omitted from the URL. */
export const VAULT_LOG_DEFAULTS = { page: 1, ps: 25, range: '7d' } as const;

const FILTER_KEYS = [
  'q',
  'result',
  'origin_check',
  'evaluate',
  'session',
  'entry',
  'since',
  'until',
] as const;

/** `true` when any filter (not paging/sort) is active. */
export function hasLogFilters(search: VaultLogSearch): boolean {
  return (
    FILTER_KEYS.some((key) => search[key] !== undefined) ||
    search.range !== VAULT_LOG_DEFAULTS.range
  );
}

/**
 * Cache-key params: the URL state minus defaults. An unfiltered first page in default order has only
 * neutral keys, so the WS bridge prepends `vault.access` rows into it; anything else is invalidated.
 */
export function logKeyParams(search: VaultLogSearch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue;
    if (key === 'page' && value === 1) continue;
    if (key === 'range' && value === VAULT_LOG_DEFAULTS.range) continue;
    out[key] = value;
  }
  return out;
}

/** Wire query (the window is resolved against the server clock at fetch time). */
export function logWireQuery(search: VaultLogSearch, now: number): z.input<typeof VaultLogQuery> {
  const custom = search.since !== undefined || search.until !== undefined;
  const window: { readonly since?: number; readonly until?: number } = custom
    ? {
        ...(search.since !== undefined && { since: search.since }),
        ...(search.until !== undefined && { until: search.until }),
      }
    : rangeWindow(search.range, now);
  return {
    limit: search.ps,
    total: true,
    sort: WIRE_SORT[search.sort ?? 'time'],
    dir: search.dir ?? 'desc',
    ...(search.result !== undefined && { result: search.result }),
    ...(search.origin_check !== undefined && { origin_check: search.origin_check }),
    ...(search.evaluate !== undefined && { evaluate: search.evaluate }),
    ...(search.session !== undefined && { session_id: search.session }),
    ...(search.entry !== undefined && { entry_name: search.entry }),
    ...(search.q !== undefined && { q: search.q }),
    ...(window.since !== undefined && { since: window.since }),
    ...(window.until !== undefined && { until: window.until }),
  };
}

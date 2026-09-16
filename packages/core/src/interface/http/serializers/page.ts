/** @module interface/http/serializers/page — the collection envelope `{ data, page, facets?, applied, meta }` (spec 03 §5). */

import type { Page } from '../../../ports/persistence/queries.ts';

/** The paging part every list query carries after parsing. */
export interface ParsedPageQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly dir?: 'asc' | 'desc' | undefined;
  readonly total?: boolean | undefined;
  readonly sort?: string | undefined;
}

/** Wire envelope without typed facets. */
export interface Envelope<W> {
  readonly data: W[];
  readonly page: { next_cursor: string | null; limit: number; total?: number };
  readonly applied: {
    filters: Record<string, unknown>;
    sort: { key: string; dir: 'asc' | 'desc' };
  };
  readonly meta: { now: number };
}

const PAGING_KEYS: ReadonlySet<string> = new Set([
  'cursor',
  'limit',
  'dir',
  'total',
  'sort',
  'expand',
]);

/** The filters the server applied (defaults included; paging and sort keys excluded). */
export function appliedFilters(query: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!PAGING_KEYS.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

/** Projects a repository page onto the wire envelope with `map` applied to every item. */
export function envelope<T, W>(
  page: Page<T>,
  map: (item: T) => W,
  query: ParsedPageQuery & object,
  now: number,
  defaultSort: string,
): Envelope<W> {
  return {
    data: page.items.map(map),
    page: {
      next_cursor: page.nextCursor,
      limit: query.limit,
      ...(page.total !== undefined && { total: page.total }),
    },
    applied: {
      filters: appliedFilters(query),
      sort: { key: query.sort ?? defaultSort, dir: query.dir ?? 'desc' },
    },
    meta: { now },
  };
}

/** The repository paging fields of a parsed wire query (`exactOptionalPropertyTypes`-safe). */
export function pagingOf(query: ParsedPageQuery): {
  limit: number;
  cursor?: string;
  dir?: 'asc' | 'desc';
  total?: boolean;
} {
  return {
    limit: query.limit,
    ...(query.cursor !== undefined && { cursor: query.cursor }),
    ...(query.dir !== undefined && { dir: query.dir }),
    ...(query.total !== undefined && { total: query.total }),
  };
}

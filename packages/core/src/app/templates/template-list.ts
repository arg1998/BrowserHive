/** @module app/templates/template-list — `GET /templates` over the whole (small, operator-made) set: facets, filters, sort and the keyset page (spec 13 §11.1, spec 03 §5). Sorting by `in_use` and filtering by `host_state` need the host side, so this runs in the service, not in SQL. */

import type { TemplateSummary, TemplatesPage, TemplatesQuery } from '@browserhive/contracts/http';
import { registrableDomain } from '../../kernel/url.ts';
import type { TemplateRecord, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import { decodeListCursor, encodeListCursor } from './list-cursor.ts';

/** One template with its sites and its summary (host facts included). */
export interface ListRow {
  readonly record: TemplateRecord;
  readonly sites: readonly TemplateSiteRecord[];
  readonly summary: TemplateSummary;
}

function sortValue(row: ListRow, key: TemplatesQuery['sort']): number | string {
  switch (key) {
    case 'name':
      return row.summary.name;
    case 'created_at':
      return row.record.createdAt;
    case 'last_used_at':
      return row.summary.last_used_at ?? 0;
    case 'in_use':
      return row.summary.in_use;
  }
}

function compare(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function facet(values: readonly string[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || compare(a.value, b.value));
}

/**
 * The `?site=` filter as a site id: a host reduces to its registrable domain like a site at
 * creation (`www.linkedin.com` → `linkedin.com`); a value with no registrable domain stays as given.
 */
export function siteFilterOf(site: string): string {
  const reduced = registrableDomain(site);
  return reduced === '' ? site : reduced;
}

/**
 * The page of `rows` that `query` asks for. Facets count every template before filtering.
 *
 * @throws AppError `VALIDATION_FAILED` for a cursor minted elsewhere.
 */
export function pageTemplates(
  rows: readonly ListRow[],
  query: TemplatesQuery,
  now: number,
): TemplatesPage {
  const facets = {
    status: facet(rows.map((r) => r.record.status)),
    host_state: facet(rows.map((r) => r.summary.host.state)),
    health: facet(rows.flatMap((r) => r.sites.map((s) => s.health.state))),
  };
  const q = query.q?.toLowerCase();
  const site = query.site === undefined ? undefined : siteFilterOf(query.site);
  const filtered = rows.filter(
    (r) =>
      (query.status === undefined || query.status.includes(r.record.status)) &&
      (query.host_state === undefined || query.host_state.includes(r.summary.host.state)) &&
      (site === undefined || r.sites.some((s) => s.siteId === site)) &&
      (q === undefined ||
        r.record.name.includes(q) ||
        r.record.displayName.toLowerCase().includes(q) ||
        r.record.description.toLowerCase().includes(q)),
  );
  const direction = query.dir === 'asc' ? 1 : -1;
  const keyed = filtered
    .map((r) => ({ ...r, key: sortValue(r, query.sort) }))
    .sort(
      (a, b) =>
        direction * compare(a.key, b.key) ||
        direction * compare(a.record.templateId, b.record.templateId),
    );
  const cursor = decodeListCursor(query.cursor);
  const start =
    cursor === null
      ? 0
      : keyed.findIndex(
          (r) =>
            direction * compare(r.key, cursor.key) > 0 ||
            (compare(r.key, cursor.key) === 0 &&
              direction * compare(r.record.templateId, cursor.id) > 0),
        );
  const from = start < 0 ? keyed.length : start;
  const pageRows = keyed.slice(from, from + query.limit);
  const last = pageRows.at(-1);
  const more = from + query.limit < keyed.length;
  return {
    data: pageRows.map((r) => r.summary),
    page: {
      next_cursor:
        more && last !== undefined
          ? encodeListCursor({ key: last.key, id: last.record.templateId })
          : null,
      limit: query.limit,
      ...(query.total && { total: keyed.length }),
    },
    facets,
    applied: {
      filters: {
        ...(query.status !== undefined && { status: query.status }),
        ...(query.host_state !== undefined && { host_state: query.host_state }),
        ...(site !== undefined && { site }),
        ...(query.q !== undefined && { q: query.q }),
      },
      sort: { key: query.sort, dir: query.dir },
    },
    meta: { now },
  };
}

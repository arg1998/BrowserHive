/** @module contracts/http/pages — navigation history ("pages"; UI label "Websites") (spec 03 §4.2–4.3) */
import { z } from 'zod';
import { UrlCategory } from '../enums/index.ts';
import { EventId, SessionId, TabId } from '../ids/index.ts';
import {
  Count,
  csv,
  EpochMs,
  Facet,
  limitQuery,
  listQuery,
  page,
  QueryText,
  sortable,
  TimeWindow,
  windowQuery,
} from './common.ts';

/** One page visit (`pages` row). */
export const PageRow = z.object({
  event_id: EventId,
  session_id: SessionId,
  tab_id: TabId,
  url: z.string(),
  title: z.string().nullable(),
  domain: z.string(),
  category: UrlCategory,
  ts: EpochMs,
});
/** One page visit. */
export type PageRow = z.infer<typeof PageRow>;

/** Page row in cross-session lists (adds the slug for labels). */
export const FleetPageRow = PageRow.extend({ session_slug: z.string().nullable() });
/** Page row in cross-session lists. */
export type FleetPageRow = z.infer<typeof FleetPageRow>;

/** Lowercased registrable domain filter. */
const domainFilter = z.string().trim().toLowerCase().min(1).max(253).optional();

/** `GET /sessions/{session_id}/pages` query. */
export const SessionPagesQuery = listQuery({
  sort: sortable(['ts']).default('ts'),
  filters: {
    category: csv(UrlCategory),
    domain: domainFilter,
    tab_id: TabId.optional(),
    q: QueryText.optional(),
  },
});
/** `GET /sessions/{session_id}/pages` query. */
export type SessionPagesQuery = z.infer<typeof SessionPagesQuery>;

/** `GET /sessions/{session_id}/pages` body. */
export const SessionPagesPage = page(PageRow);
/** `GET /sessions/{session_id}/pages` body. */
export type SessionPagesPage = z.infer<typeof SessionPagesPage>;

/** Sort keys accepted by `GET /pages`. */
export const PageSortKey = sortable(['ts', 'domain', 'category', 'session']);
/** Sort keys accepted by `GET /pages`. */
export type PageSortKey = z.infer<typeof PageSortKey>;

/** `GET /pages` query (navigation history across sessions). */
export const PagesQuery = listQuery({
  sort: PageSortKey.default('ts'),
  filters: {
    category: csv(UrlCategory),
    session_id: SessionId.optional(),
    domain: domainFilter,
    q: QueryText.optional(),
    ...windowQuery,
  },
});
/** `GET /pages` query. */
export type PagesQuery = z.infer<typeof PagesQuery>;

/** `GET /pages` body. */
export const PagesPage = page(FleetPageRow).extend({
  /**
   * Visit counts per URL category for the current filters, ignoring `category` itself
   * (disjunctive). Categories with no visits are omitted.
   */
  facets: z.object({ category: z.array(Facet) }),
});
/** `GET /pages` body. */
export type PagesPage = z.infer<typeof PagesPage>;

/** `GET /pages/recent` query (`limit` ≤ 200, default 15). */
export const RecentPagesQuery = z.strictObject({ limit: limitQuery(200, 15) });
/** `GET /pages/recent` query. */
export type RecentPagesQuery = z.infer<typeof RecentPagesQuery>;

/** `GET /pages/recent` body. */
export const RecentPagesResponse = z.object({ data: z.array(FleetPageRow), now: EpochMs });
/** `GET /pages/recent` body. */
export type RecentPagesResponse = z.infer<typeof RecentPagesResponse>;

/** `GET /pages/domains` query (`limit` ≤ 100, default 5; no window = all-time). */
export const PageDomainsQuery = z.strictObject({ ...windowQuery, limit: limitQuery(100, 5) });
/** `GET /pages/domains` query. */
export type PageDomainsQuery = z.infer<typeof PageDomainsQuery>;

/** One domain with its visit count. */
export const DomainCount = z.object({ domain: z.string(), count: Count });
/** One domain with its visit count. */
export type DomainCount = z.infer<typeof DomainCount>;

/** `GET /pages/domains` body. */
export const PageDomainsResponse = z.object({
  data: z.array(DomainCount),
  window: TimeWindow,
  now: EpochMs,
});
/** `GET /pages/domains` body. */
export type PageDomainsResponse = z.infer<typeof PageDomainsResponse>;

/** @module ports/persistence/pages — visited pages repository. */

import type { FacetCount, Page, PageListQuery, TopDomainsQuery } from './queries.ts';
import type { PageRecord } from './records.ts';

/** A page row joined with its session slug. */
export interface PageListRow extends PageRecord {
  readonly sessionSlug: string | null;
}

/** Domain popularity row. */
export interface DomainCount {
  readonly domain: string;
  readonly count: number;
}

/** Facet counts returned next to a pages list. */
export interface PageFacets {
  /** Visits per URL category; every filter applies except `categories` (disjunctive). */
  readonly categories: readonly FacetCount[];
}

/** Repository over `pages`. */
export interface PageRepository {
  /** Inserts a page visit; duplicate `eventId` is ignored. */
  insert(record: PageRecord): Promise<void>;
  /** Lists visits with filters (`GET /pages`, `GET /sessions/{id}/pages`). */
  list(query: PageListQuery): Promise<Page<PageListRow>>;
  /** Facet counts for the same filters as {@link PageRepository.list} (`GET /pages` category facets). */
  facets(query: PageListQuery): Promise<PageFacets>;
  /** Most recent visits across sessions, newest first (`limit` clamped to 1..200). */
  recent(limit: number): Promise<readonly PageListRow[]>;
  /** Most visited domains in a window, excluding hostless pages. */
  topDomains(query: TopDomainsQuery): Promise<readonly DomainCount[]>;
}

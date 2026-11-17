/** @module features/site-packs/search — URL state of `/site-packs` (spec 13 §11.4): the tab (`packs`, `history`, `hits`), the source chips (`source`: Local, Bundled; Online and Imported arrive with the registry), Updates available (`pending=1`) and the search (`q`); and the REST query they make */
import type { SitePacksQuery } from '@browserhive/contracts/http';
import { z } from 'zod';
import { csvParam, queryParam } from '@/lib/search/table.ts';

/** Source chips of T3a (the registry's `registry` and `import` arrive with T4b). */
export const PACK_SOURCE_CHIPS = ['local', 'bundled'] as const;

/** Tabs of the page. */
export const SITE_PACK_TABS = ['packs', 'history', 'hits'] as const;
/** A tab. */
export type SitePackTab = (typeof SITE_PACK_TABS)[number];

/** `/site-packs` search. */
export const sitePacksSearch = z.object({
  tab: z.enum(SITE_PACK_TABS).default('packs').catch('packs'),
  source: csvParam(z.enum(PACK_SOURCE_CHIPS)),
  pending: z.coerce.number().pipe(z.literal(1)).optional().catch(undefined),
  q: queryParam,
});
/** `/site-packs` search. */
export type SitePacksSearch = z.infer<typeof sitePacksSearch>;
/** Defaults omitted from the URL. */
export const SITE_PACKS_DEFAULTS = { tab: 'packs' } as const;

/** `true` when a filter is on. */
export function hasPackFilters(search: SitePacksSearch): boolean {
  return search.source !== undefined || search.pending !== undefined || search.q !== undefined;
}

/** The `GET /site-packs` query of a search. */
export function toSitePacksQuery(search: SitePacksSearch): z.input<typeof SitePacksQuery> {
  return {
    ...(search.q !== undefined && { q: search.q }),
    ...(search.source !== undefined && { source: search.source }),
    ...(search.pending === 1 && { pending: true }),
  };
}

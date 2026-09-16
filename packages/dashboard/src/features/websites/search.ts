/** @module features/websites/search — `/websites` search params: range/since/until, category csv, session_id, domain, top, table params; sort `time|session|category|domain` (spec 04 §12.5) */
import { UrlCategory } from '@browserhive/contracts/enums';
import { z } from 'zod';
import { epochParam } from '@/features/overview/search.ts';
import { csvParam, TABLE_SEARCH_DEFAULTS, tableSearchSchema } from '@/lib/search/table.ts';
import { rangeParam } from '@/lib/search/time-range.ts';

/** Sort keys shown in the UI → API sort keys. */
export const WEBSITES_SORT = {
  time: 'ts',
  session: 'session',
  category: 'category',
  domain: 'domain',
} as const;

/** Search schema. */
export const websitesSearch = tableSearchSchema(['time', 'session', 'category', 'domain']).extend({
  range: rangeParam,
  since: epochParam,
  until: epochParam,
  category: csvParam(UrlCategory),
  session_id: z.string().min(1).optional().catch(undefined),
  domain: z.string().trim().min(1).optional().catch(undefined),
  top: z.coerce
    .number()
    .pipe(z.union([z.literal(5), z.literal(10), z.literal(25), z.literal(100)]))
    .catch(10)
    .default(10),
});
/** Parsed search. */
export type WebsitesSearch = z.infer<typeof websitesSearch>;
/** Defaults omitted from the URL. */
export const WEBSITES_DEFAULTS = { ...TABLE_SEARCH_DEFAULTS, range: '7d', top: 10 } as const;

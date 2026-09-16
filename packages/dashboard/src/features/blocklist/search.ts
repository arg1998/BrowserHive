/** @module features/blocklist/search — `/blocklist` search params: range/since/until, source csv, pattern, domain, session_id, table params; sort `time|session|source|domain|pattern` (spec 04 §12.6) */
import { BlockedSource } from '@browserhive/contracts/enums';
import { z } from 'zod';
import { epochParam } from '@/features/overview/search.ts';
import { csvParam, TABLE_SEARCH_DEFAULTS, tableSearchSchema } from '@/lib/search/table.ts';
import { rangeParam } from '@/lib/search/time-range.ts';

/** UI sort keys → API sort keys. */
export const BLOCKLIST_SORT = {
  time: 'ts',
  session: 'session',
  source: 'source',
  domain: 'domain',
  pattern: 'pattern',
} as const;

/** Search schema. */
export const blocklistSearch = tableSearchSchema([
  'time',
  'session',
  'source',
  'domain',
  'pattern',
]).extend({
  range: rangeParam,
  since: epochParam,
  until: epochParam,
  source: csvParam(BlockedSource),
  pattern: z.string().min(1).optional().catch(undefined),
  domain: z.string().trim().min(1).optional().catch(undefined),
  session_id: z.string().min(1).optional().catch(undefined),
});
/** Parsed search. */
export type BlocklistSearch = z.infer<typeof blocklistSearch>;
/** Defaults omitted from the URL. */
export const BLOCKLIST_DEFAULTS = { ...TABLE_SEARCH_DEFAULTS, range: '7d' } as const;

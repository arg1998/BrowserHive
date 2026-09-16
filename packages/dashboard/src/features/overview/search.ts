/** @module features/overview/search — `/overview` search params: `range` (default 7d) and custom `since`/`until` (spec 04 §12.1) */
import { z } from 'zod';
import { rangeParam } from '@/lib/search/time-range.ts';

/** Epoch-ms bound coerced from the URL; invalid → absent. */
export const epochParam = z.coerce.number().int().nonnegative().optional().catch(undefined);

/** Search schema (an unknown `chart` param is dropped: the chart is always shown). */
export const overviewSearch = z.object({
  range: rangeParam,
  since: epochParam,
  until: epochParam,
});
/** Parsed search. */
export type OverviewSearch = z.infer<typeof overviewSearch>;
/** Defaults omitted from the URL. */
export const OVERVIEW_DEFAULTS = { range: '7d' } as const;

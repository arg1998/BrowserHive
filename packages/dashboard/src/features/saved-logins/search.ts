/** @module features/saved-logins/search — `/saved-logins` search params: the shared table params (sort `saved|name|kind|owner|size`) and `owner` (spec 04 §12.7.1) */
import { z } from 'zod';
import { TABLE_SEARCH_DEFAULTS, tableSearchSchema } from '@/lib/search/table.ts';

/** Sort keys (sorted in the browser: the list is small and arrives whole). */
export const SAVED_LOGIN_SORT_KEYS = ['saved', 'name', 'kind', 'owner', 'size'] as const;

/** Search schema. */
export const savedLoginsSearch = tableSearchSchema(SAVED_LOGIN_SORT_KEYS).extend({
  owner: z.string().trim().min(1).max(256).optional().catch(undefined),
});
/** Parsed search. */
export type SavedLoginsSearch = z.infer<typeof savedLoginsSearch>;
/** Defaults omitted from the URL. */
export const SAVED_LOGINS_DEFAULTS = TABLE_SEARCH_DEFAULTS;

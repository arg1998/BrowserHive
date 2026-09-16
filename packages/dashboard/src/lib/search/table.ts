/** @module lib/search/table — shared list search params (page, ps, sort, dir, q) and the URL-state rules (spec 04 §12) */
import { z } from 'zod';

/** Page sizes offered app-wide (one default: 25). */
export const PAGE_SIZES = [25, 50, 100] as const;
/** Page size. */
export type PageSize = (typeof PAGE_SIZES)[number];
/** The one default page size. */
export const DEFAULT_PAGE_SIZE: PageSize = 25;
/** Sort direction. */
export const SortDir = z.enum(['asc', 'desc']);
/** Sort direction. */
export type SortDir = z.infer<typeof SortDir>;

/** `page` param: integer ≥ 1, invalid → 1. */
export const pageParam = z.coerce.number().int().min(1).catch(1).default(1);
/** `ps` param: one of the page sizes, invalid → 25. */
export const pageSizeParam = z.coerce
  .number()
  .pipe(z.union([z.literal(25), z.literal(50), z.literal(100)]))
  .catch(DEFAULT_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE);
/** `q` param: trimmed free text, empty → absent. */
export const queryParam = z
  .string()
  .trim()
  .transform((s) => (s.length === 0 ? undefined : s))
  .optional()
  .catch(undefined);

/**
 * Multi-select param: comma list in the URL (`?state=live,paused`), array in code. Values not in
 * `item` are dropped; an empty result is absent.
 */
export function csvParam<T extends z.ZodType<string>>(item: T) {
  return z
    .preprocess((value) => {
      if (value === undefined || value === null || value === '') return undefined;
      const parts = Array.isArray(value) ? value : String(value).split(',');
      // Drop only the values `item` rejects; the valid ones survive.
      const kept = parts
        .map((p) => String(p).trim())
        .filter((p) => p.length > 0 && item.safeParse(p).success);
      return kept.length > 0 ? kept : undefined;
    }, z.array(item).min(1).optional())
    .catch(undefined);
}

/** The shared table params for a page whose sort keys are `sortKeys`. */
export function tableSearchSchema<const K extends readonly [string, ...string[]]>(sortKeys: K) {
  return z.object({
    page: pageParam,
    ps: pageSizeParam,
    sort: z.enum(sortKeys).optional().catch(undefined),
    dir: SortDir.optional().catch(undefined),
    q: queryParam,
  });
}

/** Shape of the shared table params (independent of the sort key set). */
export interface TableSearch {
  readonly page: number;
  readonly ps: PageSize;
  readonly sort?: string | undefined;
  readonly dir?: SortDir | undefined;
  readonly q?: string | undefined;
}

/** Defaults omitted from the URL. */
export const TABLE_SEARCH_DEFAULTS = { page: 1, ps: DEFAULT_PAGE_SIZE } as const;

/** Sort cycle on a header click: none → desc → asc → none. */
export function nextSort(
  current: { readonly sort?: string | undefined; readonly dir?: SortDir | undefined },
  key: string,
): { readonly sort: string | undefined; readonly dir: SortDir | undefined } {
  if (current.sort !== key) return { sort: key, dir: 'desc' };
  if (current.dir === 'desc') return { sort: key, dir: 'asc' };
  return { sort: undefined, dir: undefined };
}

/** Keys whose change does not reset the page. */
const PAGE_NEUTRAL_KEYS: ReadonlySet<string> = new Set(['page']);

/**
 * Apply a patch to a search object following the URL-state rules: any filter/sort change resets
 * `page` to 1; `undefined` removes a key; empty strings and empty arrays count as removal.
 */
export function applySearchPatch<S extends Record<string, unknown>>(
  current: S,
  patch: Partial<Record<keyof S & string, unknown>>,
): S {
  const next: Record<string, unknown> = { ...current };
  let resetPage = false;
  for (const [key, value] of Object.entries(patch)) {
    const cleared =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);
    if (cleared) delete next[key];
    else next[key] = value;
    if (!PAGE_NEUTRAL_KEYS.has(key)) resetPage = true;
  }
  if (resetPage && !('page' in patch)) delete next['page'];
  return next as S;
}

/** Remove keys equal to their default (deep-equal for arrays) so the URL stays canonical. */
export function omitDefaults<S extends Record<string, unknown>>(
  search: S,
  defaults: Readonly<Record<string, unknown>>,
): Partial<S> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue;
    const fallback = defaults[key];
    if (fallback !== undefined && sameValue(value, fallback)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value === '') continue;
    out[key] = value;
  }
  return out as Partial<S>;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Serialise a csv param value for links. */
export function toCsv(values: readonly string[] | undefined): string | undefined {
  return values === undefined || values.length === 0 ? undefined : values.join(',');
}

/** Clamp a page into `[1, pages]` where `pages` is derived from `total`/`ps` (never unmounts the pager). */
export function clampPage(page: number, total: number | undefined, ps: number): number {
  if (total === undefined) return Math.max(1, page);
  const pages = Math.max(1, Math.ceil(total / ps));
  return Math.min(Math.max(1, page), pages);
}

/** @module features/sessions/detail-search — `/sessions/$id` search: tab (activity · screenshots · files · details), live pane + takeover arm, activity filters and view, screenshots paging; alias tabs (`timeline|tools|pages|overview|live|…`) and their keys normalise onto the canonical tabs and filters so shared links keep working */
import { ScreenshotKind, TimelineKind } from '@browserhive/contracts/http';
import { z } from 'zod';
import { csvParam, pageParam, pageSizeParam, queryParam } from '@/lib/search/table.ts';

/** Session page tabs, in display order. */
export const SESSION_TABS = ['activity', 'screenshots', 'files', 'details'] as const;
/** Session page tab. */
export type SessionTab = (typeof SESSION_TABS)[number];

/** `?flag=1` param: `1` when on, absent when off (accepts `1`, `"1"` and `true` from hand-written URLs). */
const flagParam = z
  .preprocess(
    (value) => (value === 1 || value === '1' || value === true ? 1 : undefined),
    z.literal(1).optional(),
  )
  .catch(undefined);

/** Activity display modes. */
export const ACTIVITY_VIEWS = ['list', 'table'] as const;
/** Activity display mode. */
export type ActivityView = (typeof ACTIVITY_VIEWS)[number];

/** Session page search schema. */
export const sessionPageSearch = z.object({
  tab: z.enum(SESSION_TABS).catch('activity').default('activity'),
  /** Live pane open. */
  live: flagParam,
  /** Arm keyboard capture once the takeover gate opens (attention "Take over" deep link). */
  takeover: flagParam,
  // activity
  kinds: csvParam(TimelineKind),
  errors_only: flagParam,
  q: queryParam,
  view: z.enum(ACTIVITY_VIEWS).optional().catch(undefined),
  /** Expanded activity rows (timeline item ids). */
  open: csvParam(z.string().min(1).max(80)),
  // screenshots
  shots: csvParam(ScreenshotKind),
  page: pageParam,
  ps: pageSizeParam,
});
/** Parsed session page search. */
export type SessionPageSearch = z.infer<typeof sessionPageSearch>;
/** Defaults omitted from the URL. */
export const SESSION_PAGE_DEFAULTS = { tab: 'activity', page: 1, ps: 25 } as const;

/** Keys that belong to one tab and are dropped when switching tabs. */
export const TAB_SCOPED_KEYS = [
  'kinds',
  'errors_only',
  'q',
  'open',
  'shots',
  'page',
  'ps',
] as const;

/** Patch that switches tabs and clears every tab-scoped key (the live pane stays as it is). */
export function tabPatch(tab: SessionTab): Record<string, unknown> {
  const patch: Record<string, unknown> = { tab };
  for (const key of TAB_SCOPED_KEYS) patch[key] = undefined;
  return patch;
}

/** Alias `tab` values accepted in session links and the canonical tab + filters each one opens. */
const TAB_ALIASES: Readonly<Record<string, Record<string, unknown>>> = {
  overview: { tab: 'details' },
  identity: { tab: 'details' },
  timeline: {},
  tools: { kinds: ['tool'] },
  pages: { kinds: ['page'] },
  vault: { kinds: ['vault'] },
  live: { live: 1 },
};

/** Alias-only search keys; they are dropped (after mapping `ok` and `kind`) when a search is normalised. */
const ALIAS_KEYS = ['expanded', 'follow', 'sort', 'dir', 'tool', 'ok', 'kind', 'pane', 'size'];

/**
 * Rewrite a raw search that uses alias tabs or keys (`?tab=tools&ok=0`) into the canonical shape
 * (`?kinds=tool&errors_only=1`). Returns `null` when the search is already canonical.
 */
export function normalizeSessionSearchAliases(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const tab = typeof raw['tab'] === 'string' ? raw['tab'] : undefined;
  const aliasTab = tab !== undefined && tab in TAB_ALIASES;
  const aliasKeys = ALIAS_KEYS.filter((key) => raw[key] !== undefined);
  if (!aliasTab && aliasKeys.length === 0) return null;
  const next: Record<string, unknown> = { ...raw };
  for (const key of ALIAS_KEYS) delete next[key];
  if (aliasTab) {
    delete next['tab'];
    Object.assign(next, TAB_ALIASES[tab]);
  }
  if (raw['ok'] === '0' || raw['ok'] === 0) next['errors_only'] = 1;
  if (typeof raw['kind'] === 'string' && next['shots'] === undefined) next['shots'] = raw['kind'];
  return next;
}

/** Validate a raw search, normalising alias tabs and keys first. */
export function parseSessionPageSearch(raw: Record<string, unknown>): SessionPageSearch {
  return sessionPageSearch.parse(normalizeSessionSearchAliases(raw) ?? raw);
}

/** Stream size presets (per viewer, `set_size`). */
export const STREAM_SIZES = ['fit', '720p', '1080p', 'native'] as const;
/** Stream size preset. */
export type StreamSize = (typeof STREAM_SIZES)[number];

/** `/sessions/$id/live` (an alias route that only redirects): `takeover` survives the redirect. */
export const sessionLiveRedirectSearch = z.object({ takeover: flagParam });

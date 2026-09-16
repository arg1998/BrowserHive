/** @module lib/ws/bridge — feed event → query cache patch table; unknown events are ignored, unclean patches invalidate (spec 04 §5) */
import type { WsFeedEvent } from '@browserhive/contracts/ws';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { keys } from '../api/keys.ts';

/** Feed event type. */
type EventType = WsFeedEvent['type'];
/** Payload for one event type. */
type Payload<T extends EventType> = Extract<WsFeedEvent, { type: T }>;
/** A patch. */
type Patch<T extends EventType> = (ctx: BridgeContext, payload: Payload<T>) => void;

/** What a patch may touch. */
export interface BridgeContext {
  readonly queryClient: QueryClient;
  readonly topic: string;
}

/** Collection envelope as it sits in the cache (structural, never trusted beyond shape). */
interface CachedPage {
  readonly data: readonly Record<string, unknown>[];
  readonly page: { readonly total?: number } & Record<string, unknown>;
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCachedPage(value: unknown): value is CachedPage {
  return isRecord(value) && Array.isArray(value['data']) && isRecord(value['page']);
}

/** Keys allowed on a list whose first page may receive a prepend without changing membership. */
const NEUTRAL_KEYS: ReadonlySet<string> = new Set(['page', 'ps', 'sort', 'dir', 'limit', 'total']);

/** A list can take a prepend only when it is the unfiltered first page in default (desc) order. */
export function canPrepend(params: unknown, createdSortKeys: readonly string[]): boolean {
  if (!isRecord(params)) return true;
  for (const key of Object.keys(params)) {
    if (!NEUTRAL_KEYS.has(key) && params[key] !== undefined) return false;
  }
  const page = params['page'];
  if (page !== undefined && page !== 1) return false;
  const dir = params['dir'];
  if (dir !== undefined && dir !== 'desc') return false;
  const sort = params['sort'];
  return sort === undefined || (typeof sort === 'string' && createdSortKeys.includes(sort));
}

function withTotal(page: CachedPage['page'], delta: number): CachedPage['page'] {
  return page.total === undefined ? page : { ...page, total: Math.max(0, page.total + delta) };
}

/** Window keys a list may carry and still take a prepend, when the row falls inside the window. */
const WINDOW_KEYS: ReadonlySet<string> = new Set(['since', 'until']);

/**
 * Windowed variant of `canPrepend`: `since`/`until` are allowed when `ts` lies in `[since, until)`;
 * any other filter, a later page or another sort still refuses.
 */
export function canPrependWindowed(
  params: unknown,
  createdSortKeys: readonly string[],
  ts: number,
): boolean {
  if (!isRecord(params)) return true;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!WINDOW_KEYS.has(key)) rest[key] = value;
  }
  if (!canPrepend(rest, createdSortKeys)) return false;
  const since = params['since'];
  const until = params['until'];
  if (typeof since === 'number' && ts < since) return false;
  if (typeof until === 'number' && ts >= until) return false;
  return true;
}

/** Prepend `row` to every clean, windowed first page under `prefix` (dedupe by id); otherwise invalidate. */
export function prependWindowed(
  qc: QueryClient,
  prefix: QueryKey,
  idField: string,
  row: Record<string, unknown> & { readonly ts: number },
  createdSortKeys: readonly string[],
): void {
  for (const [key, data] of qc.getQueriesData({ queryKey: prefix })) {
    if (!isCachedPage(data)) continue;
    if (data.data.some((item) => item[idField] === row[idField])) continue;
    if (!canPrependWindowed(key[key.length - 1], createdSortKeys, row.ts)) {
      void qc.invalidateQueries({ queryKey: key, exact: true });
      continue;
    }
    qc.setQueryData(key, { ...data, data: [row, ...data.data], page: withTotal(data.page, 1) });
  }
}

/** Bump a domain count in every cached `{data:[{domain,count}]}` whose window contains `ts`; else invalidate. */
function bumpDomain(qc: QueryClient, prefix: QueryKey, domain: string, ts: number): void {
  for (const [key, data] of qc.getQueriesData({ queryKey: prefix })) {
    if (!isRecord(data) || !Array.isArray(data['data'])) continue;
    const params = key[key.length - 1];
    const list = data['data'].filter(isRecord);
    const index = list.findIndex((d) => d['domain'] === domain);
    const current = list[index];
    if (
      current === undefined ||
      typeof current['count'] !== 'number' ||
      !canPrependWindowed(
        isRecord(params) ? { since: params['since'], until: params['until'] } : {},
        [],
        ts,
      )
    ) {
      void qc.invalidateQueries({ queryKey: key, exact: true });
      continue;
    }
    const next = [...list];
    next[index] = { ...current, count: current['count'] + 1 };
    next.sort((a, b) => Number(b['count']) - Number(a['count']));
    qc.setQueryData(key, { ...data, data: next });
  }
}

/** Upsert `row` into every list under `prefix`: replace in place, prepend on clean first pages, else invalidate. */
export function upsertRow(
  qc: QueryClient,
  prefix: QueryKey,
  idField: string,
  row: Record<string, unknown>,
  createdSortKeys: readonly string[],
  onPrepend?: (page: CachedPage) => Partial<CachedPage>,
): void {
  for (const [key, data] of qc.getQueriesData({ queryKey: prefix })) {
    if (!isCachedPage(data)) continue;
    const index = data.data.findIndex((item) => item[idField] === row[idField]);
    if (index >= 0) {
      const next = [...data.data];
      next[index] = { ...data.data[index], ...row };
      qc.setQueryData(key, { ...data, data: next });
      continue;
    }
    if (canPrepend(key[key.length - 1], createdSortKeys)) {
      const extra = onPrepend?.(data) ?? {};
      qc.setQueryData(key, {
        ...data,
        ...extra,
        data: [row, ...data.data],
        page: withTotal(data.page, 1),
      });
      continue;
    }
    void qc.invalidateQueries({ queryKey: key, exact: true });
  }
}

/** Patch fields of an existing row in every list under `prefix` (no insert). */
export function patchRow(
  qc: QueryClient,
  prefix: QueryKey,
  idField: string,
  id: unknown,
  patch: Record<string, unknown>,
): void {
  for (const [key, data] of qc.getQueriesData({ queryKey: prefix })) {
    if (!isCachedPage(data)) continue;
    const index = data.data.findIndex((item) => item[idField] === id);
    if (index < 0) continue;
    const next = [...data.data];
    next[index] = { ...data.data[index], ...patch };
    qc.setQueryData(key, { ...data, data: next });
  }
}

/** Remove a row from every list under `prefix`. */
export function removeRow(qc: QueryClient, prefix: QueryKey, idField: string, id: unknown): void {
  for (const [key, data] of qc.getQueriesData({ queryKey: prefix })) {
    if (!isCachedPage(data)) continue;
    if (!data.data.some((item) => item[idField] === id)) continue;
    qc.setQueryData(key, {
      ...data,
      data: data.data.filter((item) => item[idField] !== id),
      page: withTotal(data.page, -1),
    });
  }
}

/** Patch an object query (detail, status) when present. */
function patchObject(
  qc: QueryClient,
  key: QueryKey,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  const current = qc.getQueryData(key);
  if (!isRecord(current)) return;
  qc.setQueryData(key, update(current));
}

/** Add `delta` to a numeric query (counts). */
function bumpCount(qc: QueryClient, key: QueryKey, delta: number): void {
  const current = qc.getQueryData(key);
  if (typeof current !== 'number') return;
  qc.setQueryData(key, Math.max(0, current + delta));
}

function bumpDetailCount(qc: QueryClient, sessionId: string, field: string, delta: number): void {
  patchObject(qc, keys.sessions.detail(sessionId), (detail) => {
    const counts = detail['counts'];
    if (!isRecord(counts) || typeof counts[field] !== 'number') return detail;
    const session = detail['session'];
    const nextCounts = { ...counts, [field]: Math.max(0, counts[field] + delta) };
    return {
      ...detail,
      counts: nextCounts,
      ...(isRecord(session) && { session: { ...session, counts: nextCounts } }),
    };
  });
}

function invalidate(qc: QueryClient, key: QueryKey): void {
  void qc.invalidateQueries({ queryKey: key });
}

/** Timeline item kinds the bridge can build from feed events. */
type TimelineFacet = 'tool' | 'page' | 'vault' | 'blocked' | 'attention';

/**
 * The unique timeline item id (`<kind>:<row id>`), the same formula the REST timeline uses: a
 * navigate call and the page visit it produced share `event_id` but never `id`.
 */
export function timelineItemKey(facet: TimelineFacet, row: Record<string, unknown>): string {
  const rowId = facet === 'attention' ? row['request_id'] : row['event_id'];
  return `${facet}:${String(rowId)}`;
}

/** Id of a cached timeline item: its `id`, or the formula for items cached before ids existed. */
function cachedItemKey(item: Record<string, unknown>): string | null {
  if (typeof item['id'] === 'string') return item['id'];
  const kind = item['kind'];
  const row = item['row'];
  if (typeof kind !== 'string' || !isRecord(row)) return null;
  return timelineItemKey(kind as TimelineFacet, row);
}

/** Does a cached facet key (`all`, `tool`, `page,tool`) show items of `facet`? */
function facetShows(keyFacet: unknown, facet: TimelineFacet): 'all' | 'exact' | 'multi' | 'no' {
  if (keyFacet === 'all') return 'all';
  if (typeof keyFacet !== 'string') return 'no';
  const kinds = keyFacet.split(',');
  if (!kinds.includes(facet)) return 'no';
  return kinds.length === 1 ? 'exact' : 'multi';
}

/**
 * Upsert a timeline row into every cached timeline page of a session that shows its kind. Rows are
 * wrapped in the `TimelineItem` envelope (`{kind, id, ts, seq, row}`) the REST timeline returns
 * and deduped by `id`; an existing item is replaced in place (attention resolving). Filtered pages
 * (`q`, `errors_only`, a cursor) are refetched instead, since membership is unknown.
 */
function upsertTimeline(
  qc: QueryClient,
  sessionId: string,
  facet: TimelineFacet,
  row: Record<string, unknown> & { readonly ts: number },
): void {
  const id = timelineItemKey(facet, row);
  const item = { kind: facet, id, ts: row.ts, seq: 0, row };
  for (const [key, data] of qc.getQueriesData({ queryKey: keys.sessions.timelines(sessionId) })) {
    const shows = facetShows(key[3], facet);
    if (shows === 'no') continue; // includes the per-event `tool-call` detail
    if (!isCachedPage(data)) {
      invalidate(qc, key);
      continue;
    }
    const index = data.data.findIndex((existing) => cachedItemKey(existing) === id);
    if (index >= 0) {
      const next = [...data.data];
      next[index] = { ...data.data[index], ...item, ts: data.data[index]?.['ts'] ?? row.ts };
      qc.setQueryData(key, { ...data, data: next });
      continue;
    }
    if (!canPrepend(key[4], ['ts', 'time'])) {
      invalidate(qc, key);
      continue;
    }
    qc.setQueryData(key, { ...data, data: [item, ...data.data], page: withTotal(data.page, 1) });
  }
}

/** The notification fields the bridge reads (structural). */
interface NotificationLike {
  readonly notification_id: string;
  readonly type: string;
  readonly read_at: number | null;
  readonly dismissed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** Keys of a cached `GET /notifications` list whose membership the bridge can judge. */
const NOTIFICATION_KEYS: ReadonlySet<string> = new Set([
  ...NEUTRAL_KEYS,
  'read',
  'type',
  'since',
  'until',
]);

/**
 * Does the cached list with these key params show `n` on its first page? `unknown` for a later page,
 * a `created_at` or ascending sort, or a filter the bridge can't evaluate. The server never lists
 * dismissed rows; `read` is `all|unread|read`, `type` a csv set, and the window applies to `updated_at`.
 */
export function notificationMembership(
  params: unknown,
  n: NotificationLike,
): 'in' | 'out' | 'unknown' {
  const p = isRecord(params) ? params : {};
  for (const key of Object.keys(p)) {
    if (!NOTIFICATION_KEYS.has(key) && p[key] !== undefined) return 'unknown';
  }
  if (p['page'] !== undefined && p['page'] !== 1) return 'unknown';
  if (p['sort'] !== undefined && p['sort'] !== 'updated_at') return 'unknown';
  if (p['dir'] !== undefined && p['dir'] !== 'desc') return 'unknown';
  if (n.dismissed_at !== null) return 'out';
  if (p['read'] === 'unread' && n.read_at !== null) return 'out';
  if (p['read'] === 'read' && n.read_at === null) return 'out';
  const type = p['type'];
  if (type !== undefined) {
    const types: readonly unknown[] = Array.isArray(type) ? type : String(type).split(',');
    if (!types.includes(n.type)) return 'out';
  }
  const since = p['since'];
  const until = p['until'];
  if (typeof since === 'number' && n.updated_at < since) return 'out';
  if (typeof until === 'number' && n.updated_at >= until) return 'out';
  return 'in';
}

const isUnreadRow = (n: Record<string, unknown>): boolean =>
  n['read_at'] === null && n['dismissed_at'] === null;

/** Latest activity first: the server's default `updated_at desc` order. */
function byUpdatedDesc(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const at = (row: Record<string, unknown>) => Number(row['updated_at'] ?? row['created_at'] ?? 0);
  return at(b) - at(a) || Number(b['created_at'] ?? 0) - Number(a['created_at'] ?? 0);
}

/**
 * `notification.created` / `notification.updated` are upserts by `notification_id`. A folded
 * tool-error group grows in place and moves to the top; a read/dismiss change replaces the row, or
 * drops it from lists that no longer show it; a row a first page doesn't hold is inserted at its
 * `updated_at` position. Unread counts move only when a row's unread state really changes (a growing
 * group was already unread), so the bell badge and the inbox never double count. Lists whose
 * membership can't be judged (later pages, other sorts) refetch when they held the row.
 */
function upsertNotification(qc: QueryClient, n: NotificationLike, created: boolean): void {
  const prefix = keys.notifications.lists();
  const row = n as unknown as Record<string, unknown>;
  let previous: Record<string, unknown> | undefined;
  for (const [, data] of qc.getQueriesData({ queryKey: prefix })) {
    if (!isCachedPage(data)) continue;
    previous ??= data.data.find((item) => item['notification_id'] === n.notification_id);
  }
  const nowUnread = isUnreadRow(row);
  // A created row is new; an update no cache holds keeps its unread state (group growth stays unread).
  const unreadDelta =
    previous !== undefined
      ? Number(nowUnread) - Number(isUnreadRow(previous))
      : created && nowUnread
        ? 1
        : 0;
  for (const [key, data] of qc.getQueriesData({ queryKey: prefix })) {
    if (!isCachedPage(data)) continue;
    const index = data.data.findIndex((item) => item['notification_id'] === n.notification_id);
    const membership = notificationMembership(key[key.length - 1], n);
    const unread = data['unread_count'];
    const withUnread =
      typeof unread === 'number' && unreadDelta !== 0
        ? { unread_count: Math.max(0, unread + unreadDelta) }
        : {};
    if (membership === 'unknown') {
      if (index < 0) {
        if (created) void qc.invalidateQueries({ queryKey: key, exact: true });
        else if (unreadDelta !== 0) qc.setQueryData(key, { ...data, ...withUnread });
        continue;
      }
      const prev = data.data[index];
      if (prev?.['updated_at'] !== n.updated_at) {
        void qc.invalidateQueries({ queryKey: key, exact: true });
        continue;
      }
      const next = [...data.data];
      next[index] = { ...prev, ...row };
      qc.setQueryData(key, { ...data, ...withUnread, data: next });
      continue;
    }
    const rest = index >= 0 ? data.data.filter((_, i) => i !== index) : data.data;
    if (membership === 'out') {
      qc.setQueryData(key, {
        ...data,
        ...withUnread,
        data: rest,
        page: index >= 0 ? withTotal(data.page, -1) : data.page,
      });
      continue;
    }
    const merged = index >= 0 ? { ...data.data[index], ...row } : row;
    const at = rest.findIndex((item) => byUpdatedDesc(merged, item) < 0);
    const next = at < 0 ? [...rest, merged] : [...rest.slice(0, at), merged, ...rest.slice(at)];
    // An unknown row joins the total when it is new, or when the page holds the whole result (it
    // can't be on a later page); with more pages it may have moved up from one, so the total stays.
    const joins = index < 0 && (created || data.page['next_cursor'] === null);
    qc.setQueryData(key, {
      ...data,
      ...withUnread,
      data: next,
      page: joins ? withTotal(data.page, 1) : data.page,
    });
  }
  if (unreadDelta !== 0) bumpCount(qc, keys.notifications.unreadCount(), unreadDelta);
}

const SESSION_CREATED_KEYS = ['created', 'created_at'] as const;

/** The table (spec 04 §5). Add a row here for every new WS-driven update (spec 04 §15). */
export const BRIDGE: { readonly [T in EventType]?: Patch<T> } = {
  'session.opened': ({ queryClient: qc }, { session }) => {
    upsertRow(qc, keys.sessions.lists(), 'session_id', session, SESSION_CREATED_KEYS);
    patchObject(qc, keys.sessions.detail(session.session_id), (d) => ({
      ...d,
      session,
      counts: session.counts,
    }));
    invalidate(qc, keys.system.status());
  },
  'session.updated': ({ queryClient: qc }, { session }) => {
    upsertRow(qc, keys.sessions.lists(), 'session_id', session, SESSION_CREATED_KEYS);
    patchObject(qc, keys.sessions.detail(session.session_id), (d) => ({
      ...d,
      session,
      counts: session.counts,
    }));
  },
  'session.closed': ({ queryClient: qc }, { session_id, closed_at, reason }) => {
    const patch = { state: 'closed', live: false, closed_at, closed_reason: reason };
    patchRow(qc, keys.sessions.lists(), 'session_id', session_id, patch);
    patchObject(qc, keys.sessions.detail(session_id), (d) => ({
      ...d,
      ...(isRecord(d['session']) && { session: { ...d['session'], ...patch } }),
    }));
    invalidate(qc, keys.system.status());
  },
  'session.removed': ({ queryClient: qc }, { session_id, action, at }) => {
    if (action === 'deleted') {
      removeRow(qc, keys.sessions.lists(), 'session_id', session_id);
      qc.removeQueries({ queryKey: keys.sessions.detail(session_id) });
      qc.removeQueries({ queryKey: keys.sessions.timelines(session_id) });
      invalidate(qc, keys.system.status());
      return;
    }
    const archived_at = action === 'archived' ? at : null;
    invalidate(qc, keys.sessions.lists());
    patchObject(qc, keys.sessions.detail(session_id), (d) => ({
      ...d,
      ...(isRecord(d['session']) && { session: { ...d['session'], archived_at } }),
    }));
  },
  'tool.called': ({ queryClient: qc }, { row }) => {
    if (row.session_id !== null) {
      upsertTimeline(qc, row.session_id, 'tool', row);
      bumpDetailCount(qc, row.session_id, 'tool_calls', 1);
      if (!row.ok) bumpDetailCount(qc, row.session_id, 'errors', 1);
    }
    for (const [key, data] of qc.getQueriesData({ queryKey: keys.overview.all })) {
      if (!isRecord(data) || !Array.isArray(data['buckets']) || !isRecord(data['window'])) {
        invalidate(qc, key);
        continue;
      }
      const bucketMs = data['window']['bucket_ms'];
      const buckets = data['buckets'];
      const index =
        typeof bucketMs === 'number'
          ? buckets.findIndex(
              (b) =>
                isRecord(b) &&
                typeof b['ts'] === 'number' &&
                row.ts >= b['ts'] &&
                row.ts < b['ts'] + bucketMs,
            )
          : -1;
      const bucket = index >= 0 ? buckets[index] : undefined;
      if (!isRecord(bucket)) {
        invalidate(qc, key);
        continue;
      }
      const next = [...buckets];
      next[index] = {
        ...bucket,
        tool_calls: (typeof bucket['tool_calls'] === 'number' ? bucket['tool_calls'] : 0) + 1,
        errors: (typeof bucket['errors'] === 'number' ? bucket['errors'] : 0) + (row.ok ? 0 : 1),
      };
      qc.setQueryData(key, { ...data, buckets: next });
    }
  },
  'page.visited': ({ queryClient: qc }, { row }) => {
    upsertTimeline(qc, row.session_id, 'page', row);
    bumpDetailCount(qc, row.session_id, 'pages', 1);
    const fleetRow = { session_slug: null, ...row };
    patchObject(qc, keys.websites.recent(), (recent) => {
      const list = recent['data'];
      if (!Array.isArray(list)) return recent;
      if (list.some((r) => isRecord(r) && r['event_id'] === row.event_id)) return recent;
      return { ...recent, data: [fleetRow, ...list].slice(0, 15) };
    });
    prependWindowed(qc, keys.websites.histories(), 'event_id', fleetRow, ['ts', 'time']);
    bumpDomain(qc, keys.websites.domainLists(), row.domain, row.ts);
  },
  'screenshot.captured': ({ queryClient: qc }, { row }) => {
    invalidate(qc, keys.sessions.screenshots(row.session_id));
  },
  'attention.created': ({ queryClient: qc }, { request }) => {
    upsertRow(qc, keys.attention.lists(), 'request_id', request, ['created', 'created_at']);
    upsertRow(qc, keys.attention.pending(), 'request_id', request, ['created', 'created_at']);
    bumpCount(qc, keys.attention.openCount(), 1);
    // `attention_open` arrives with the server's `session.updated` (live counts): this event is
    // delivered on both `attention` and `session:<id>`, so bumping here would double count.
    invalidate(qc, keys.sessions.attention(request.session_id));
    upsertTimeline(qc, request.session_id, 'attention', { ...request, ts: request.created_at });
  },
  'attention.resolved': ({ queryClient: qc }, { request }) => {
    upsertRow(qc, keys.attention.lists(), 'request_id', request, ['created', 'created_at']);
    removeRow(qc, keys.attention.pending(), 'request_id', request.request_id);
    bumpCount(qc, keys.attention.openCount(), -1);
    invalidate(qc, keys.sessions.attention(request.session_id));
    upsertTimeline(qc, request.session_id, 'attention', { ...request, ts: request.created_at });
  },
  'vault.confirm.created': ({ queryClient: qc }, { request }) => {
    upsertRow(qc, keys.vault.confirms(), 'request_id', request, ['created', 'created_at']);
    bumpCount(qc, keys.vault.confirmCount(), 1);
    invalidate(qc, keys.sessions.confirms(request.session_id));
  },
  'vault.confirm.resolved': ({ queryClient: qc }, { request }) => {
    removeRow(qc, keys.vault.confirms(), 'request_id', request.request_id);
    bumpCount(qc, keys.vault.confirmCount(), -1);
    invalidate(qc, keys.sessions.confirms(request.session_id));
  },
  'vault.access': ({ queryClient: qc }, { row }) => {
    upsertRow(qc, keys.vault.logs(), 'event_id', row, ['time', 'ts']);
    if (row.session_id === null) return;
    upsertTimeline(qc, row.session_id, 'vault', row);
    bumpDetailCount(qc, row.session_id, 'vault_access', 1);
  },
  'vault.binding.changed': ({ queryClient: qc }) => {
    invalidate(qc, keys.vault.bindings());
    invalidate(qc, keys.vault.state());
  },
  'vault.policy.changed': ({ queryClient: qc }) => {
    invalidate(qc, keys.vault.groups());
    invalidate(qc, keys.vault.state());
  },
  'vault.lock_state': ({ queryClient: qc }, { unlocked }) => {
    patchObject(qc, keys.vault.status(), (s) => ({ ...s, unlocked }));
    patchObject(qc, keys.vault.state(), (s) => ({ ...s, unlocked }));
  },
  'blocklist.hit': ({ queryClient: qc }, { row }) => {
    prependWindowed(qc, keys.blocklist.attemptLists(), 'event_id', row, ['time', 'ts']);
    invalidate(qc, keys.blocklist.stats());
    if (row.session_id === null) return;
    upsertTimeline(qc, row.session_id, 'blocked', row);
    bumpDetailCount(qc, row.session_id, 'blocked', 1);
  },
  'blocklist.reloaded': ({ queryClient: qc }) => {
    invalidate(qc, keys.blocklist.all);
  },
  'system.degraded': ({ queryClient: qc }) => {
    invalidate(qc, keys.system.status());
    invalidate(qc, keys.system.events());
  },
  'system.recovered': ({ queryClient: qc }) => {
    invalidate(qc, keys.system.status());
    invalidate(qc, keys.system.events());
  },
  'system.capacity': ({ queryClient: qc }, { live, max }) => {
    patchObject(qc, keys.system.status(), (s) => ({
      ...s,
      capacity: { ...(isRecord(s['capacity']) ? s['capacity'] : {}), live, max },
    }));
  },
  'retention.completed': ({ queryClient: qc }) => {
    invalidate(qc, keys.system.status());
  },
  'notification.created': ({ queryClient: qc }, { notification }) => {
    upsertNotification(qc, notification, true);
  },
  'notification.updated': ({ queryClient: qc }, { notification }) => {
    upsertNotification(qc, notification, false);
  },
};

/** Apply one feed event to the cache. Returns `true` when the table had a row for it. */
export function applyFeedEvent(
  queryClient: QueryClient,
  event: WsFeedEvent,
  topic: string,
): boolean {
  const patch = BRIDGE[event.type] as Patch<typeof event.type> | undefined;
  if (patch === undefined) return false;
  patch({ queryClient, topic }, event);
  return true;
}

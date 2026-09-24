/** @module interface/http/serializers/sessions — session rows/aggregates → `SessionSummary`, session list query → repository query (spec 03 §4.2). */

import type { SessionFacets, SessionSummary, SessionsQuery } from '@browserhive/contracts/http';
import type { z } from 'zod';
import { toWireClient } from '../../../app/sessions/metadata.ts';
import type {
  SessionFacets as RepoFacets,
  SessionListQuery,
} from '../../../ports/persistence/queries.ts';
import type { SessionListRow } from '../../../ports/persistence/records.ts';
import { pagingOf } from './page.ts';

/** Wire (input) shape of a session summary. */
export type WireSessionSummary = z.input<typeof SessionSummary>;

const TERMINAL_STATES: ReadonlySet<string> = new Set(['closed', 'crashed']);

/** A stored session row (closed or not yet live-overlaid) as the wire summary. */
export function sessionRowToSummary(
  row: SessionListRow,
  now: number,
  hasLiveViewers: boolean,
): WireSessionSummary {
  const open = row.closedAt === null && !TERMINAL_STATES.has(row.state);
  const remaining = open ? Math.max(0, row.leaseExpiresAt - (row.leasePausedAt ?? now)) : 0;
  return {
    session_id: row.sessionId,
    slug: row.slug,
    owner: row.owner,
    tenant_id: row.tenantId,
    channel: row.channel,
    engine: row.engine,
    headless: row.headless,
    incognito: row.incognito,
    persistence_mode: row.persistenceMode,
    current_url: row.lastUrl,
    created_at: row.createdAt,
    last_activity_at: row.lastActivityAt,
    closed_at: row.closedAt,
    closed_reason: row.closedReason,
    archived_at: row.archivedAt,
    lease_expires_at: row.leaseExpiresAt,
    lease_paused_at: row.leasePausedAt,
    lease_remaining_ms: remaining,
    state: row.state,
    live: open,
    disable_evaluate: row.disableEvaluate,
    vault_enabled: row.vaultEnabled,
    stealth: row.stealth,
    fingerprint: row.fingerprint,
    humanize: row.humanize,
    stealth_recorded: row.stealth && row.identity !== null,
    identity: row.identity === null ? null : { ...row.identity },
    proxy_label: row.proxyLabel,
    counts: countsOf(row),
    has_live_viewers: hasLiveViewers,
    client: toWireClient(row.client),
  };
}

/** Per-session counters of a row. */
export function countsOf(row: SessionListRow): WireSessionSummary['counts'] {
  return {
    tool_calls: row.counts.toolCalls,
    errors: row.counts.errors,
    pages: row.counts.pages,
    blocked: row.counts.blocked,
    attention_open: row.counts.attentionOpen,
    vault_access: row.counts.vaultAccess,
  };
}

/**
 * Overlays the live aggregate's summary on a stored row: live state, URL, lease and counters win;
 * the row supplies `archived_at` (the aggregate never knows it).
 */
export function overlayLive(
  live: z.output<typeof SessionSummary>,
  row: SessionListRow | null,
  hasLiveViewers: boolean,
): WireSessionSummary {
  return {
    ...live,
    archived_at: row?.archivedAt ?? live.archived_at,
    // Both come from the same connection; the row covers a session whose aggregate predates it.
    client: live.client ?? toWireClient(row?.client ?? null),
    has_live_viewers: hasLiveViewers,
  };
}

/** `GET /sessions` query → repository query. */
export function sessionsQueryToRepo(query: z.output<typeof SessionsQuery>): SessionListQuery {
  return {
    ...pagingOf(query),
    sort: query.sort,
    view: query.view,
    archived: query.archived,
    ...(query.state !== undefined && { states: query.state }),
    ...(query.owner !== undefined && { owner: query.owner }),
    ...(query.channel !== undefined && { channels: query.channel }),
    ...(query.persistence_mode !== undefined && { persistenceModes: query.persistence_mode }),
    ...(query.q !== undefined && { q: query.q }),
    ...(query.since !== undefined && { since: query.since }),
    ...(query.until !== undefined && { until: query.until }),
  };
}

/** Repository facets → wire facets. */
export function facetsToWire(facets: RepoFacets): z.input<typeof SessionFacets> {
  const map = (rows: RepoFacets['owners']) => rows.map((r) => ({ value: r.value, count: r.count }));
  return {
    owners: map(facets.owners),
    channels: map(facets.channels),
    persistence_modes: map(facets.persistenceModes),
    states: map(facets.states),
  };
}

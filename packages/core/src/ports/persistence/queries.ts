/** @module ports/persistence/queries — list query and page shapes shared by the repositories (spec 03 §4–5). */

import type {
  AttentionMode,
  BlockSource,
  NotificationType,
  OperatorRequestKind,
  OperatorRequestStatus,
  OriginCheck,
  PageCategory,
  PersistenceMode,
  ScreenshotKind,
  SessionChannel,
  SessionState,
  SystemEventSeverity,
  VaultAccessResult,
} from './enums.ts';

/** One page of a keyset-paginated list. `total` is present only when the query asked for it. */
export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page, `null` on the last page. */
  readonly nextCursor: string | null;
  readonly total?: number;
}

/** Sort direction. */
export type SortDir = 'asc' | 'desc';

/** Pagination fields common to every list query. */
export interface PageQuery {
  /** Page size, default 50, clamped to 1..500. */
  readonly limit?: number;
  /** Cursor from a previous {@link Page}; a cursor minted for another resource is rejected. */
  readonly cursor?: string | null;
  /** Sort direction; each resource declares its default. */
  readonly dir?: SortDir;
  /** When true, a separate COUNT with the same WHERE fills `Page.total`. */
  readonly total?: boolean;
}

/** Optional epoch-ms time window on the resource's primary timestamp. */
export interface TimeWindow {
  readonly since?: number;
  readonly until?: number;
}

/** Sort keys of `GET /sessions`. */
export type SessionSortKey =
  | 'created_at'
  | 'slug'
  | 'channel'
  | 'last_activity_at'
  | 'errors'
  | 'lease_expires_at'
  | 'closed_at'
  | 'owner'
  | 'persistence_mode'
  | 'blocked';

/** Filters of `GET /sessions`. */
export interface SessionListQuery extends PageQuery, TimeWindow {
  readonly states?: readonly SessionState[];
  /** `all` = every non-archived row; `live` = open rows; `closed` = closed rows; `archived` = archived only. */
  readonly view?: 'all' | 'live' | 'closed' | 'archived';
  readonly archived?: 'exclude' | 'include' | 'only';
  readonly owner?: string;
  readonly channels?: readonly SessionChannel[];
  readonly persistenceModes?: readonly PersistenceMode[];
  /** Free text over slug and session id. */
  readonly q?: string;
  readonly sort?: SessionSortKey;
}

/** Facet counts returned next to a sessions page. */
export interface SessionFacets {
  readonly owners: readonly FacetCount[];
  readonly channels: readonly FacetCount[];
  readonly persistenceModes: readonly FacetCount[];
  readonly states: readonly FacetCount[];
}

/** One facet value with its row count. */
export interface FacetCount {
  readonly value: string;
  readonly count: number;
}

/** Filters of `GET /tool-calls` and `GET /sessions/{id}/tool-calls`. */
export interface ToolCallListQuery extends PageQuery, TimeWindow {
  readonly sessionId?: string;
  /** `true`: only calls recorded in a session; `false`: only session-less calls. */
  readonly hasSession?: boolean;
  readonly tools?: readonly string[];
  readonly ok?: boolean;
  /** `true`: only calls with an `error_code` (hard and soft failures); `false`: only calls without. */
  readonly hasError?: boolean;
  readonly errorCodes?: readonly string[];
  /** Free text over tool, error code, error message and tab id. */
  readonly q?: string;
  readonly sort?: 'ts' | 'duration_ms';
}

/** Filters of `GET /pages` and `GET /sessions/{id}/pages`. */
export interface PageListQuery extends PageQuery, TimeWindow {
  readonly sessionId?: string;
  readonly categories?: readonly PageCategory[];
  readonly domain?: string;
  readonly tabId?: string;
  /** Free text over url and title. */
  readonly q?: string;
  readonly sort?: 'ts' | 'domain' | 'category' | 'session';
}

/** Filters of `GET /pages/domains`. */
export interface TopDomainsQuery extends TimeWindow {
  /** Default 5, max 100. */
  readonly limit?: number;
}

/** Filters of `GET /sessions/{id}/screenshots`. */
export interface ScreenshotListQuery extends PageQuery, TimeWindow {
  readonly kinds?: readonly ScreenshotKind[];
}

/** Filters of `GET /vault/log`. */
export interface VaultAccessListQuery extends PageQuery, TimeWindow {
  readonly sessionId?: string;
  readonly results?: readonly VaultAccessResult[];
  readonly originChecks?: readonly OriginCheck[];
  readonly evaluate?: 'on' | 'off';
  readonly entryName?: string;
  /** Free text over entry name, page url and session id. */
  readonly q?: string;
  readonly sort?: 'ts' | 'entry_name' | 'result' | 'session';
}

/** Filters of `GET /blocklist/attempts`. */
export interface BlockedRequestListQuery extends PageQuery, TimeWindow {
  readonly sessionId?: string;
  readonly pattern?: string;
  readonly domain?: string;
  readonly sources?: readonly BlockSource[];
  /** Free text over url and pattern. */
  readonly q?: string;
  readonly sort?: 'ts' | 'domain' | 'pattern' | 'session' | 'source';
}

/** Aggregates of `GET /blocklist` (`stats`). */
export interface BlockedStats {
  readonly attempts: number;
  readonly sessions: number;
  readonly domains: number;
  readonly totalAllTime: number;
  readonly topPatterns: readonly {
    readonly pattern: string;
    readonly count: number;
    readonly lastTs: number;
  }[];
  readonly topDomains: readonly { readonly domain: string; readonly count: number }[];
}

/** Filters of `GET /attention` and `GET /vault/confirm` history views. */
export interface OperatorRequestListQuery extends PageQuery, TimeWindow {
  readonly kind?: OperatorRequestKind;
  readonly statuses?: readonly OperatorRequestStatus[];
  readonly modes?: readonly AttentionMode[];
  readonly sessionId?: string;
  /** Free text over reason and session id. */
  readonly q?: string;
  readonly sort?: 'created_at' | 'resolved_at' | 'waited_ms';
}

/** Filters of `GET /notifications`. */
export interface NotificationListQuery extends PageQuery, TimeWindow {
  /** Order and time-window column; default `updated_at` (a coalesced group moves up when it grows). */
  readonly sort?: 'updated_at' | 'created_at';
  readonly principalId?: string | null;
  readonly read?: 'all' | 'unread' | 'read';
  readonly types?: readonly NotificationType[];
}

/** Filters of `GET /system/events`. */
export interface SystemEventListQuery extends PageQuery, TimeWindow {
  readonly severities?: readonly SystemEventSeverity[];
  readonly openOnly?: boolean;
}

/** Filters of `GET /vault/bindings`. */
export interface VaultBindingListQuery extends PageQuery {
  readonly groupId?: string | null;
  /** Free text over handle, title and item name. */
  readonly q?: string;
}

/** Cursor-only query for audit logs (`auth_events`, `operator_actions`). */
export interface AuditListQuery extends PageQuery, TimeWindow {
  readonly principalId?: string;
  readonly types?: readonly string[];
}

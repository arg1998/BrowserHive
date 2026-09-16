/** @module ports/persistence/analytics — reporting read model behind `/activity`, `/metrics/tools`, `/timeline`. */

import type { BlockedRequestListRow } from './blocklist-audit.ts';
import type { OperatorRequestListRow } from './operator-requests.ts';
import type { DomainCount, PageListRow } from './pages.ts';
import type { Page, PageQuery, TimeWindow, TopDomainsQuery } from './queries.ts';
import type { ToolCallListRow } from './tool-calls.ts';
import type { VaultAccessListRow } from './vault-audit.ts';

/** Query of `GET /activity`. */
export interface ActivityQuery {
  readonly since: number;
  readonly until: number;
  /** Bucket width, clamped to 60 000..86 400 000 ms and widened so at most 720 buckets result. */
  readonly bucketMs?: number;
  readonly groupBy?: 'tool' | 'error_code' | 'session';
}

/** One activity bucket; `groups` present only when `groupBy` was asked. */
export interface ActivityBucket {
  readonly ts: number;
  readonly toolCalls: number;
  readonly errors: number;
  readonly sessionsStarted: number;
  readonly sessionsClosed: number;
  readonly blocked: number;
  readonly attention: number;
  readonly groups?: Readonly<Record<string, number>>;
}

/** Result of `activity`. */
export interface ActivityResult {
  readonly buckets: readonly ActivityBucket[];
  readonly window: { readonly since: number; readonly until: number; readonly bucketMs: number };
}

/** Headline counters (`/activity.summary`). */
export interface ActivitySummary {
  readonly sessionsTotal: number;
  readonly sessionsLive: number;
  readonly sessionsWindow: number;
  readonly toolCallsWindow: number;
  readonly toolCallsTotal: number;
  readonly errorsWindow: number;
  readonly errorsTotal: number;
  readonly blockedWindow: number;
  readonly blockedTotal: number;
  readonly attentionOpen: number;
}

/** Query of `GET /metrics/tools`. */
export interface ToolMetricsQuery extends TimeWindow {
  readonly groupBy: 'tool' | 'error_code' | 'tool,error_code';
  readonly sessionId?: string;
}

/** One metrics row. */
export interface ToolMetricsRow {
  readonly tool: string | null;
  readonly errorCode: string | null;
  readonly calls: number;
  readonly errors: number;
  readonly errorRate: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/** Timeline item kinds. */
export type TimelineKind = 'tool' | 'page' | 'attention' | 'vault' | 'blocked';

/** Query of `GET /sessions/{id}/timeline`. */
export interface TimelineQuery extends PageQuery, TimeWindow {
  readonly kinds?: readonly TimelineKind[];
  /**
   * Failures only: tool calls with an `error_code`, attention that ended `rejected`/`timeout`/
   * `cancelled`, vault fills that did not succeed, and every blocked request. Pages are excluded.
   */
  readonly errorsOnly?: boolean;
  /**
   * Free text, applied per kind: tool (name, error code, error message, tab id), page (url, title),
   * attention (reason, session id), vault (entry name, page url, session id), blocked (url, pattern).
   */
  readonly q?: string;
}

/** One merged timeline item, discriminated on `kind`; `id` is `<kind>:<event_id | request_id>` (unique). */
export type TimelineItem =
  | {
      readonly kind: 'tool';
      readonly ts: number;
      readonly id: string;
      readonly item: ToolCallListRow;
    }
  | { readonly kind: 'page'; readonly ts: number; readonly id: string; readonly item: PageListRow }
  | {
      readonly kind: 'attention';
      readonly ts: number;
      readonly id: string;
      readonly item: OperatorRequestListRow;
    }
  | {
      readonly kind: 'vault';
      readonly ts: number;
      readonly id: string;
      readonly item: VaultAccessListRow;
    }
  | {
      readonly kind: 'blocked';
      readonly ts: number;
      readonly id: string;
      readonly item: BlockedRequestListRow;
    };

/** Analytical read model; every method is read-only and drains pending writes first. */
export interface AnalyticsQueries {
  /** Gap-filled, axis-aligned activity buckets. */
  activity(query: ActivityQuery): Promise<ActivityResult>;
  /** Per-tool / per-error latency and error-rate metrics. */
  toolMetrics(query: ToolMetricsQuery): Promise<readonly ToolMetricsRow[]>;
  /** Merged per-session timeline sorted by `(ts, id)` descending. */
  timeline(sessionId: string, query: TimelineQuery): Promise<Page<TimelineItem>>;
  /** Headline counters over the trailing `windowMs`. */
  summary(now: number, windowMs: number): Promise<ActivitySummary>;
  /** `page_count * page_size` of the main database file. */
  databaseSize(): Promise<number>;
  /** Most visited domains (`GET /pages/domains`). */
  topDomains(query: TopDomainsQuery): Promise<readonly DomainCount[]>;
}

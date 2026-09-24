/** @module interface/http/routes/fleet — cross-session tool calls, pages, activity and tool metrics (spec 03 §4.3). */

import { harnessLabel } from '@browserhive/contracts/harness';
import {
  ACTIVITY_DEFAULT_WINDOW_MS,
  ActivityQuery,
  ActivityResponse,
  HarnessMetricsQuery,
  HarnessMetricsResponse,
  PageDomainsQuery,
  PageDomainsResponse,
  PagesPage,
  PagesQuery,
  RecentPagesQuery,
  RecentPagesResponse,
  ToolCallsPage,
  ToolCallsQuery,
  ToolMetricsQuery,
  ToolMetricsResponse,
} from '@browserhive/contracts/http';
import { defineRoute, reply } from '../define-route.ts';
import {
  fleetPageToWire,
  fleetToolCallToWire,
  pagesQueryToRepo,
  toolCallsQueryToRepo,
} from '../serializers/facts.ts';
import { envelope } from '../serializers/page.ts';

/** Fleet-wide routes. */
export const FLEET_ROUTES = [
  defineRoute({
    operationId: 'listToolCalls',
    tags: ['activity'],
    summary: 'Tool calls across sessions (live feed seed, fleet error views).',
    request: { query: ToolCallsQuery },
    responses: { 200: ToolCallsPage },
    async handler({ input, services, ctx }) {
      const detail = input.query.expand === 'detail';
      const page = await services.repos.toolCalls.listAll(toolCallsQueryToRepo(input.query));
      return reply(
        200,
        envelope(page, (row) => fleetToolCallToWire(row, detail), input.query, ctx.now, 'ts'),
      );
    },
  }),
  defineRoute({
    operationId: 'getActivity',
    tags: ['activity'],
    summary: 'Gap-filled activity buckets (≤ 720) and headline counters.',
    request: { query: ActivityQuery },
    responses: { 200: ActivityResponse },
    async handler({ input, services, ctx }) {
      const until = input.query.until ?? ctx.now;
      const since = input.query.since ?? until - ACTIVITY_DEFAULT_WINDOW_MS;
      const [result, summary] = await Promise.all([
        services.analytics.activity({
          since,
          until,
          ...(input.query.bucket_ms !== undefined && { bucketMs: input.query.bucket_ms }),
          ...(input.query.group_by !== undefined && { groupBy: input.query.group_by }),
        }),
        services.analytics.summary(until, until - since),
      ]);
      return reply(200, {
        buckets: result.buckets.map((b) => ({
          ts: b.ts,
          tool_calls: b.toolCalls,
          errors: b.errors,
          sessions_started: b.sessionsStarted,
          sessions_closed: b.sessionsClosed,
          blocked: b.blocked,
          attention: b.attention,
          ...(b.groups !== undefined && { groups: { ...b.groups } }),
        })),
        summary: {
          sessions_total: summary.sessionsTotal,
          sessions_live: summary.sessionsLive,
          sessions_window: summary.sessionsWindow,
          tool_calls_window: summary.toolCallsWindow,
          tool_calls_total: summary.toolCallsTotal,
          errors_window: summary.errorsWindow,
          errors_total: summary.errorsTotal,
          blocked_window: summary.blockedWindow,
          blocked_total: summary.blockedTotal,
          attention_open: summary.attentionOpen,
          active_screencasts: services.realtime.activeScreencasts(),
        },
        window: {
          since: result.window.since,
          until: result.window.until,
          bucket_ms: result.window.bucketMs,
        },
        now: ctx.now,
      });
    },
  }),
  defineRoute({
    operationId: 'getToolMetrics',
    tags: ['activity'],
    summary: 'Per-tool call counts, error rate and latency percentiles.',
    request: { query: ToolMetricsQuery },
    responses: { 200: ToolMetricsResponse },
    async handler({ input, services, ctx }) {
      const q = input.query;
      const rows = await services.analytics.toolMetrics({
        groupBy: q.group_by,
        ...(q.session_id !== undefined && { sessionId: q.session_id }),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
      });
      const byError = q.group_by !== 'tool';
      return reply(200, {
        data: rows.map((r) => ({
          tool: r.tool ?? '',
          ...(byError && { error_code: r.errorCode }),
          calls: r.calls,
          errors: r.errors,
          error_rate: r.errorRate,
          p50_ms: r.p50Ms,
          p95_ms: r.p95Ms,
          p99_ms: r.p99Ms,
          max_ms: r.maxMs,
        })),
        now: ctx.now,
      });
    },
  }),
  defineRoute({
    operationId: 'getHarnessMetrics',
    tags: ['activity'],
    summary:
      'Sessions and tool calls per agent harness over a window (self-reported identity, D-30).',
    request: { query: HarnessMetricsQuery },
    responses: { 200: HarnessMetricsResponse },
    async handler({ input, services, ctx }) {
      const until = input.query.until ?? ctx.now;
      const since = input.query.since ?? until - ACTIVITY_DEFAULT_WINDOW_MS;
      const rows = await services.analytics.harnessMetrics({ since, until });
      return reply(200, {
        data: rows.map((r) => ({
          harness: r.harness,
          label: harnessLabel(r.harness),
          sessions: r.sessions,
          sessions_live: r.sessionsLive,
          tool_calls: r.toolCalls,
          errors: r.errors,
        })),
        window: { since, until },
        now: ctx.now,
      });
    },
  }),
  defineRoute({
    operationId: 'listPages',
    tags: ['pages'],
    summary: 'Pages across sessions (navigation history) with category facets.',
    request: { query: PagesQuery },
    responses: { 200: PagesPage },
    async handler({ input, services, ctx }) {
      const query = pagesQueryToRepo(input.query);
      const [page, facets] = await Promise.all([
        services.repos.pages.list(query),
        services.repos.pages.facets(query),
      ]);
      return reply(200, {
        ...envelope(page, fleetPageToWire, input.query, ctx.now, 'ts'),
        facets: { category: [...facets.categories] },
      });
    },
  }),
  defineRoute({
    operationId: 'listRecentPages',
    tags: ['pages'],
    summary: 'Most recent page visits across sessions.',
    request: { query: RecentPagesQuery },
    responses: { 200: RecentPagesResponse },
    async handler({ input, services, ctx }) {
      const rows = await services.repos.pages.recent(input.query.limit);
      return reply(200, { data: rows.map(fleetPageToWire), now: ctx.now });
    },
  }),
  defineRoute({
    operationId: 'listPageDomains',
    tags: ['pages'],
    summary: 'Most visited domains (all-time when no window).',
    request: { query: PageDomainsQuery },
    responses: { 200: PageDomainsResponse },
    async handler({ input, services, ctx }) {
      const q = input.query;
      const rows = await services.repos.pages.topDomains({
        limit: q.limit,
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
      });
      return reply(200, {
        data: rows.map((r) => ({ domain: r.domain, count: r.count })),
        window: { since: q.since ?? null, until: q.until ?? null },
        now: ctx.now,
      });
    },
  }),
];

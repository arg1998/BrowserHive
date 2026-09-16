/** @module interface/http/routes/blocklist — blocklist overview, reload and attempts (spec 03 §4.6, D-22). */

import {
  BlockedAttemptsPage,
  BlockedAttemptsQuery,
  BlocklistOverview,
  BlocklistOverviewQuery,
  ReloadBlocklistResponse,
} from '@browserhive/contracts/http';
import { defineRoute, reply } from '../define-route.ts';
import { blockedQueryToRepo, blockedToWire } from '../serializers/facts.ts';
import { envelope } from '../serializers/page.ts';

const tags = ['blocklist'];

/** Blocklist routes. */
export const BLOCKLIST_ROUTES = [
  defineRoute({
    operationId: 'getBlocklist',
    tags,
    summary: 'Loaded patterns with hit counts, skipped lines and window stats.',
    request: { query: BlocklistOverviewQuery },
    responses: { 200: BlocklistOverview },
    async handler({ input, services, ctx }) {
      const window = {
        ...(input.query.since !== undefined && { since: input.query.since }),
        ...(input.query.until !== undefined && { until: input.query.until }),
      };
      const stats = await services.repos.blocklistAudit.stats(window, 100);
      const hits = new Map(stats.topPatterns.map((p) => [p.pattern, p]));
      const blocklist = services.blocklist;
      return reply(200, {
        configured: blocklist.configured,
        path: blocklist.path,
        loaded_at: blocklist.loadedAt(),
        patterns: blocklist.patterns().map((p) => ({
          pattern: p.pattern,
          line: p.line,
          hits: hits.get(p.pattern)?.count ?? 0,
          last_ts: hits.get(p.pattern)?.lastTs ?? null,
        })),
        skipped: blocklist.skipped().map((s) => ({ line: s.line, text: s.text, reason: s.reason })),
        stats: {
          attempts: stats.attempts,
          sessions: stats.sessions,
          domains: stats.domains,
          total_all_time: stats.totalAllTime,
          top_patterns: stats.topPatterns.map((p) => ({ pattern: p.pattern, count: p.count })),
          top_domains: stats.topDomains.map((d) => ({ domain: d.domain, count: d.count })),
        },
        window: { since: input.query.since ?? null, until: input.query.until ?? null },
        now: ctx.now,
      });
    },
  }),
  defineRoute({
    operationId: 'reloadBlocklist',
    tags,
    summary: 'Re-read the blocklist file; on failure the previous list stays active.',
    request: {},
    responses: { 200: ReloadBlocklistResponse },
    errors: ['BLOCKLIST_LOAD_FAILED'],
    async handler({ services, ctx }) {
      const result = await services.blocklist.reload();
      return reply(200, {
        ok: true,
        patterns: result.patterns,
        skipped: result.skipped,
        loaded_at: services.blocklist.loadedAt() ?? ctx.now,
      });
    },
  }),
  defineRoute({
    operationId: 'listBlockedAttempts',
    tags,
    summary: 'Blocked request audit (served even when no blocklist is configured).',
    request: { query: BlockedAttemptsQuery },
    responses: { 200: BlockedAttemptsPage },
    async handler({ input, services, ctx }) {
      const page = await services.repos.blocklistAudit.list(blockedQueryToRepo(input.query));
      return reply(200, envelope(page, blockedToWire, input.query, ctx.now, 'ts'));
    },
  }),
];

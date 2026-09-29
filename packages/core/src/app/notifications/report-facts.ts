/** @module app/notifications/report-facts — gathers what the scheduled reports say (D-43, D-44, spec 03 §9.7) from the analytics read model and the repositories: bounded, indexed queries only, never raw SQL. */

import { parseSessionId } from '@browserhive/contracts/ids';
import type { DigestRule } from '@browserhive/contracts/notifications';
import type { AnalyticsQueries } from '../../ports/persistence/analytics.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import { type AnomalyFacts, type DigestFacts, SLOWEST_TOOL_MIN_CALLS } from './reports.ts';

const HOUR = 3_600_000;
/** Number of top errors a digest lists. */
const TOP_ERRORS = 3;

/** Where the facts come from. */
export interface ReportFactsDeps {
  readonly analytics: Pick<
    AnalyticsQueries,
    'windowCounts' | 'toolLatency' | 'topErrors' | 'harnessMetrics' | 'activity'
  >;
  readonly repos: Pick<
    Repositories,
    'operatorRequests' | 'vaultAudit' | 'blocklistAudit' | 'systemEvents'
  >;
  /** Live sessions and `maxSessions` now. */
  readonly capacity: () => { readonly live: number; readonly max: number };
}

/** The facts behind the reports (a port so the scheduler can be tested without a database). */
export interface ReportFacts {
  digest(
    window: { readonly since: number; readonly until: number },
    rule: DigestRule,
  ): Promise<DigestFacts>;
  anomaly(now: number): Promise<AnomalyFacts>;
}

/**
 * The facts of one digest window and of the anomaly check, from the read model.
 *
 * @returns A {@link ReportFacts}.
 */
export function createReportFacts(deps: ReportFactsDeps): ReportFacts {
  const { analytics, repos } = deps;
  return {
    async digest(window, rule) {
      const span = window.until - window.since;
      const previous = { since: window.since - span, until: window.since };
      const [counts, prev, attention, pending, vault, blocked, latency, prevLatency, errors] =
        await Promise.all([
          analytics.windowCounts(window),
          analytics.windowCounts(previous),
          repos.operatorRequests.windowStats('attention', window),
          repos.operatorRequests.countOpen('attention'),
          repos.vaultAudit.countByResult(window),
          repos.blocklistAudit.stats({ since: window.since, until: window.until - 1 }, 1),
          analytics.toolLatency(window),
          analytics.toolLatency(previous),
          analytics.topErrors(window, TOP_ERRORS),
        ]);
      const [open, harnesses, activity] = await Promise.all([
        repos.systemEvents.open(),
        analytics.harnessMetrics({ since: window.since, until: window.until - 1 }),
        analytics.activity({
          since: window.since,
          until: window.until - 1,
          bucketMs: rule.every === 'week' ? 6 * HOUR : HOUR,
        }),
      ]);
      const slowest = latency
        .filter((r) => r.calls >= SLOWEST_TOOL_MIN_CALLS)
        .sort((a, b) => b.p95Ms - a.p95Ms || a.tool.localeCompare(b.tool))[0];
      const before =
        slowest === undefined
          ? undefined
          : prevLatency.find((r) => r.tool === slowest.tool && r.calls >= SLOWEST_TOOL_MIN_CALLS);
      const pattern = blocked.topPatterns[0];
      const domain = blocked.topDomains[0];
      const buckets = activity.buckets.slice(-48);
      return {
        window: { since: window.since, until: window.until },
        sessionsStarted: counts.sessionsStarted,
        sessionsLive: deps.capacity().live,
        toolCalls: counts.toolCalls,
        errors: counts.errors,
        previous: { toolCalls: prev.toolCalls, errors: prev.errors },
        attention: { ...attention, pending },
        vault: vault.map((v) => ({ result: v.result, count: v.count })),
        blocked: {
          count: counts.blocked,
          topPattern:
            pattern === undefined ? null : { pattern: pattern.pattern, count: pattern.count },
          topDomain: domain === undefined ? null : { domain: domain.domain, count: domain.count },
        },
        slowest:
          slowest === undefined
            ? null
            : {
                tool: slowest.tool,
                p95Ms: slowest.p95Ms,
                previousP95Ms: before?.p95Ms ?? null,
              },
        topErrors: errors.map((e) => ({ ...e })),
        degradations: open
          .filter((e) => e.severity === 'error' || e.severity === 'warn')
          .map((e) => ({
            code: e.code,
            severity: e.severity,
            message: e.message,
            since: e.firstSeenAt,
          })),
        harnesses: harnesses.map((h) => ({
          harness: h.harness,
          sessions: h.sessions,
          toolCalls: h.toolCalls,
          errors: h.errors,
        })),
        chart: {
          start: buckets[0]?.ts ?? window.since,
          stepMs: activity.window.bucketMs,
          values: buckets.map((b) => b.toolCalls),
        },
      };
    },

    async anomaly(now) {
      const window = { since: now - HOUR, until: now };
      const [counts, baseline, waiting, open] = await Promise.all([
        analytics.windowCounts(window),
        analytics.windowCounts({ since: now - 25 * HOUR, until: now - HOUR }),
        repos.operatorRequests.open('attention'),
        repos.systemEvents.open(),
      ]);
      const capacity = deps.capacity();
      return {
        window,
        toolCalls: counts.toolCalls,
        errors: counts.errors,
        blocked: counts.blocked,
        blockedBaselinePerHour: baseline.blocked / 24,
        attentionWaiting: waiting
          .map((r) => ({
            sessionSlug: r.sessionSlug ?? parseSessionId(r.sessionId)?.slug ?? null,
            waitedMs: Math.max(0, now - r.createdAt),
          }))
          .sort((a, b) => b.waitedMs - a.waitedMs),
        live: capacity.live,
        maxSessions: capacity.max,
        degradations: open
          .filter((e) => e.severity === 'error')
          .map((e) => ({ code: e.code, message: e.message, since: e.firstSeenAt })),
      };
    },
  };
}

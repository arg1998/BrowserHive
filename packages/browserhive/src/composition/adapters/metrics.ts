/** @module composition/adapters/metrics — OTel metrics consumers: bus events → counters/histograms, observable gauges over queue depth, DB size and process memory (spec 10 §7). Only wired when telemetry is on. */

import { metricHarness } from '@browserhive/contracts/harness';
import type {
  AnalyticsQueries,
  DomainEvents,
  EventBus,
  Instruments,
  WriteQueue,
} from '@browserhive/core/runtime';
import { readProcessMemory } from '@browserhive/core/runtime';

/** Sources of the observable gauges. */
export interface MetricSources {
  readonly queue: Pick<WriteQueue, 'depth'>;
  readonly analytics: Pick<AnalyticsQueries, 'databaseSize'>;
}

/** Subscribes the instrument consumers; returns the unsubscribe function. */
export function wireMetrics(
  instruments: Instruments,
  bus: EventBus<DomainEvents>,
  sources: MetricSources,
): () => void {
  const offs: (() => void)[] = [];
  const openedAt = new Map<string, number>();
  // `harness` is folded to the known slug table (spec 10 §7 cardinality rule); never model/workspace/meta.
  const harnessOf = new Map<string, string>();
  offs.push(
    bus.subscribe('tool.called', ({ payload }) => {
      const o = payload.observation;
      const attrs = {
        tool: o.tool,
        ok: o.ok,
        harness: metricHarness(o.harness),
        ...(o.errorCode !== null && { error_code: o.errorCode }),
      };
      instruments.toolCalls.add(1, attrs);
      instruments.toolCallDuration.record(o.durationMs, { tool: o.tool });
    }),
    bus.subscribe('session.opened', ({ payload }) => {
      const harness = metricHarness(payload.session.harness);
      instruments.sessionsActive.add(1, { harness });
      harnessOf.set(payload.session.session_id, harness);
      openedAt.set(payload.session.session_id, payload.session.created_at);
    }),
    bus.subscribe('session.closed', ({ payload }) => {
      instruments.sessionsActive.add(-1, {
        harness: harnessOf.get(payload.session_id) ?? metricHarness(null),
      });
      harnessOf.delete(payload.session_id);
      const started = openedAt.get(payload.session_id);
      openedAt.delete(payload.session_id);
      if (started !== undefined) {
        instruments.sessionLifetime.record(Math.max(0, payload.closed_at - started));
      }
    }),
    bus.subscribe('attention.created', () => instruments.attentionOpen.add(1)),
    bus.subscribe('attention.resolved', () => instruments.attentionOpen.add(-1)),
    bus.subscribe('vault.access', ({ payload }) =>
      instruments.vaultFills.add(1, { result: payload.row.result }),
    ),
    bus.subscribe('blocklist.hit', ({ payload }) =>
      instruments.blocklistHits.add(1, { source: payload.row.source }),
    ),
    bus.subscribe('retention.completed', ({ payload }) =>
      instruments.retentionPrunedRows.add(payload.pruned_rows),
    ),
  );

  let dbBytes = 0;
  const depth = (result: { observe(value: number): void }) => result.observe(sources.queue.depth);
  const size = (result: { observe(value: number): void }) => {
    result.observe(dbBytes);
    void sources.analytics.databaseSize().then(
      (bytes) => {
        dbBytes = bytes;
      },
      () => undefined,
    );
  };
  const rss = (result: { observe(value: number): void }) =>
    result.observe(readProcessMemory().rssBytes);
  const heap = (result: { observe(value: number): void }) =>
    result.observe(readProcessMemory().heapUsedBytes);
  instruments.dbWriteQueueDepth.addCallback(depth);
  instruments.dbSizeBytes.addCallback(size);
  instruments.processRssBytes.addCallback(rss);
  instruments.processHeapBytes.addCallback(heap);
  offs.push(() => {
    instruments.dbWriteQueueDepth.removeCallback(depth);
    instruments.dbSizeBytes.removeCallback(size);
    instruments.processRssBytes.removeCallback(rss);
    instruments.processHeapBytes.removeCallback(heap);
  });
  return () => {
    for (const off of offs.splice(0)) off();
  };
}

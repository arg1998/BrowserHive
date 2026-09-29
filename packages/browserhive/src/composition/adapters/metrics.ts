/** @module composition/adapters/metrics — OTel metrics consumers (spec 10 §7): bus events → counters/histograms; observable instruments over the write queue, the database size, the realtime hub, the browser-memory sampler and this process. Only wired when metrics are exported. */

import { metricHarness } from '@browserhive/contracts/harness';
import type {
  AnalyticsQueries,
  DomainEvents,
  EventBus,
  EventLoopLagMonitor,
  Instruments,
  WriteQueue,
} from '@browserhive/core/runtime';
import {
  DB_WRITE_TABLES,
  readProcessMemory,
  startEventLoopLagMonitor,
  WS_BUFFERED_BYTES_MAX_SERIES,
} from '@browserhive/core/runtime';
import type { ActionCounter, DeliveryCounter, ReportCounter } from '@browserhive/core/server';

/** What the realtime hub exposes to the metrics (http transport only). */
export interface RealtimeMetricsSource {
  /** Open connections and the bytes each socket has not flushed yet. */
  sockets(): readonly { readonly connectionId: string; readonly bufferedBytes: number }[];
  /** Frames dropped since start, by channel. */
  droppedFrames(): Readonly<Record<string, number>>;
}

/** The metrics view of the realtime hub, as `listeners-http` exposes it on `ctx.listeners.realtime`. */
export function realtimeMetrics(hub: {
  connections(): readonly { readonly connection_id: string; readonly buffered_bytes: number }[];
  droppedFrames(): Readonly<Record<string, number>>;
}): RealtimeMetricsSource {
  return {
    sockets: () =>
      hub
        .connections()
        .map((c) => ({ connectionId: c.connection_id, bufferedBytes: c.buffered_bytes })),
    droppedFrames: () => hub.droppedFrames(),
  };
}

/** Sources of the observable instruments. */
export interface MetricSources {
  readonly queue: Pick<WriteQueue, 'depth' | 'droppedWritesByTable'>;
  readonly analytics: Pick<AnalyticsQueries, 'databaseSize'>;
  /** The hub once the listeners are open; `undefined` before that and under stdio. */
  readonly realtime?: () => RealtimeMetricsSource | undefined;
  /** RSS bytes per session id from the browser-memory sampler's latest sample. */
  readonly browserMemory?: () => ReadonlyMap<string, number>;
  /** Starts the event-loop monitor (default the `perf_hooks` one); `null` disables the gauge. */
  readonly eventLoop?: () => EventLoopLagMonitor | null;
}

interface Observer {
  observe(value: number, attributes?: Record<string, string>): void;
}

interface ObservableInstrument {
  addCallback(callback: (result: Observer) => void): void;
  removeCallback(callback: (result: Observer) => void): void;
}

/** The notification services' counters, exactly as the composition root passes them (spec 10 §7). */
export function notificationCounters(instruments: Instruments): {
  readonly deliveryCounter: DeliveryCounter;
  readonly actionCounter: ActionCounter;
  readonly reportCounter: ReportCounter;
} {
  return {
    deliveryCounter: instruments.notificationDeliveries,
    actionCounter: instruments.notificationActions,
    reportCounter: instruments.notificationReports,
  };
}

/** Subscribes the instrument consumers and registers the callbacks; returns the unwire function. */
export function wireMetrics(
  instruments: Instruments,
  bus: EventBus<DomainEvents>,
  sources: MetricSources,
): () => void {
  const offs: (() => void)[] = [];
  const openedAt = new Map<string, number>();
  const launched = new Set<string>();
  // Operator requests seen opening: a settlement of one opened before this process started (the
  // startup reconcile) never drives the up-down counter below zero.
  const openRequests = new Map<string, string>();
  // `harness` is folded to the known slug table (spec 10 §7 cardinality rule); never model/workspace/meta.
  const harnessOf = new Map<string, string>();
  const requestOpened = (request: { readonly request_id: string; readonly kind: string }) => {
    openRequests.set(request.request_id, request.kind);
    instruments.attentionOpen.add(1, { kind: request.kind });
  };
  const requestSettled = (request: { readonly request_id: string }) => {
    const kind = openRequests.get(request.request_id);
    if (kind === undefined) return;
    openRequests.delete(request.request_id);
    instruments.attentionOpen.add(-1, { kind });
  };
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
    bus.subscribe('session.updated', ({ payload }) => {
      // `launch_ms` is set once, when the browser is attached; later patches repeat it.
      const launchMs = payload.patch.launchMs;
      const id = payload.session.session_id;
      if (typeof launchMs !== 'number' || launched.has(id) || !openedAt.has(id)) return;
      launched.add(id);
      instruments.sessionLaunchDuration.record(launchMs, {
        channel: payload.session.channel,
        stealth: payload.session.stealth,
      });
    }),
    bus.subscribe('session.closed', ({ payload }) => {
      instruments.sessionsActive.add(-1, {
        harness: harnessOf.get(payload.session_id) ?? metricHarness(null),
      });
      harnessOf.delete(payload.session_id);
      launched.delete(payload.session_id);
      const started = openedAt.get(payload.session_id);
      openedAt.delete(payload.session_id);
      if (started !== undefined) {
        instruments.sessionLifetime.record(Math.max(0, payload.closed_at - started), {
          closed_reason: payload.reason,
        });
      }
    }),
    bus.subscribe('attention.created', ({ payload }) => requestOpened(payload.request)),
    bus.subscribe('vault.confirm.created', ({ payload }) => requestOpened(payload.request)),
    bus.subscribe('vault.confirm.resolved', ({ payload }) => requestSettled(payload.request)),
    bus.subscribe('attention.resolved', ({ payload }) => {
      const r = payload.request;
      requestSettled(r);
      const waited = r.waited_ms ?? (r.resolved_at === null ? null : r.resolved_at - r.created_at);
      if (waited !== null) {
        instruments.attentionWait.record(Math.max(0, waited), { status: r.status });
      }
    }),
    bus.subscribe('vault.access', ({ payload }) =>
      instruments.vaultFills.add(1, { result: payload.row.result }),
    ),
    bus.subscribe('blocklist.hit', ({ payload }) =>
      instruments.blocklistHits.add(1, { source: payload.row.source }),
    ),
    bus.subscribe('retention.completed', ({ payload }) => {
      for (const [table, rows] of Object.entries(payload.prunedByTable ?? {})) {
        if (rows > 0) instruments.retentionPrunedRows.add(rows, { table });
      }
    }),
  );

  // The size is read in the background and reported at the next export (never blocks a collect).
  let dbBytes: number | undefined;
  const refreshSize = () =>
    void sources.analytics.databaseSize().then(
      (bytes) => {
        dbBytes = bytes;
      },
      () => undefined,
    );
  refreshSize();
  const monitor = (sources.eventLoop ?? startEventLoopLagMonitor)();

  const hub = () => sources.realtime?.();
  const callbacks: readonly [ObservableInstrument, (result: Observer) => void][] = [
    [instruments.dbWriteQueueDepth, (r) => r.observe(sources.queue.depth)],
    [
      instruments.dbDroppedWrites,
      (r) => {
        const dropped = sources.queue.droppedWritesByTable;
        for (const table of DB_WRITE_TABLES) r.observe(dropped.get(table) ?? 0, { table });
        for (const [table, count] of dropped) {
          if (!(DB_WRITE_TABLES as readonly string[]).includes(table)) r.observe(count, { table });
        }
      },
    ],
    [
      instruments.dbSizeBytes,
      (r) => {
        if (dbBytes !== undefined) r.observe(dbBytes);
        refreshSize();
      },
    ],
    [instruments.processRssBytes, (r) => r.observe(readProcessMemory().rssBytes)],
    [instruments.processHeapBytes, (r) => r.observe(readProcessMemory().heapUsedBytes)],
    [
      instruments.processEventLoopLag,
      (r) => {
        const p99 = monitor?.takeP99Ms() ?? null;
        if (p99 !== null) r.observe(p99);
      },
    ],
    [
      instruments.wsConnections,
      (r) => {
        const h = hub();
        if (h !== undefined) r.observe(h.sockets().length);
      },
    ],
    [
      instruments.wsBufferedBytes,
      (r) => {
        const top = [...(hub()?.sockets() ?? [])]
          .sort((a, b) => b.bufferedBytes - a.bufferedBytes)
          .slice(0, WS_BUFFERED_BYTES_MAX_SERIES);
        for (const s of top) r.observe(s.bufferedBytes, { connection_id: s.connectionId });
      },
    ],
    [
      instruments.wsFramesDropped,
      (r) => {
        for (const [channel, count] of Object.entries(hub()?.droppedFrames() ?? {})) {
          r.observe(count, { channel });
        }
      },
    ],
    [
      instruments.browserRssBytes,
      (r) => {
        for (const [sessionId, bytes] of sources.browserMemory?.() ?? []) {
          r.observe(bytes, { session_id: sessionId });
        }
      },
    ],
  ];
  for (const [instrument, callback] of callbacks) instrument.addCallback(callback);
  offs.push(() => {
    for (const [instrument, callback] of callbacks) instrument.removeCallback(callback);
    monitor?.stop();
  });
  return () => {
    for (const off of offs.splice(0)) off();
  };
}

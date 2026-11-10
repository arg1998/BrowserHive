/** @module composition/adapters/metrics — OTel metrics consumers (spec 10 §7): bus events → counters/histograms; observable instruments over the write queue, the database size, the realtime hub, the browser-memory sampler and this process. Only wired when metrics are exported. */
import type {
  AnalyticsQueries,
  DomainEvents,
  EventBus,
  EventLoopLagMonitor,
  Instruments,
  WriteQueue,
} from '@browserhive/core/runtime';
import type { ActionCounter, DeliveryCounter, ReportCounter } from '@browserhive/core/server';
/** What the realtime hub exposes to the metrics (http transport only). */
export interface RealtimeMetricsSource {
  /** Open connections and the bytes each socket has not flushed yet. */
  sockets(): readonly {
    readonly connectionId: string;
    readonly bufferedBytes: number;
  }[];
  /** Frames dropped since start, by channel. */
  droppedFrames(): Readonly<Record<string, number>>;
}
/** The metrics view of the realtime hub, as `listeners-http` exposes it on `ctx.listeners.realtime`. */
export declare function realtimeMetrics(hub: {
  connections(): readonly {
    readonly connection_id: string;
    readonly buffered_bytes: number;
  }[];
  droppedFrames(): Readonly<Record<string, number>>;
}): RealtimeMetricsSource;
/** Sources of the observable instruments. */
export interface MetricSources {
  readonly queue: Pick<WriteQueue, 'depth' | 'droppedWritesByTable'>;
  readonly analytics: Pick<AnalyticsQueries, 'databaseSize'>;
  /** The hub once the listeners are open; `undefined` before that and under stdio. */
  readonly realtime?: () => RealtimeMetricsSource | undefined;
  /** RSS bytes per host key (`hostKey`) from the browser-memory sampler's latest sample. */
  readonly browserMemory?: () => ReadonlyMap<string, number>;
  /** Starts the event-loop monitor (default the `perf_hooks` one); `null` disables the gauge. */
  readonly eventLoop?: () => EventLoopLagMonitor | null;
}
/** The notification services' counters, exactly as the composition root passes them (spec 10 §7). */
export declare function notificationCounters(instruments: Instruments): {
  readonly deliveryCounter: DeliveryCounter;
  readonly actionCounter: ActionCounter;
  readonly reportCounter: ReportCounter;
};
/** Subscribes the instrument consumers and registers the callbacks; returns the unwire function. */
export declare function wireMetrics(
  instruments: Instruments,
  bus: EventBus<DomainEvents>,
  sources: MetricSources,
): () => void;
//# sourceMappingURL=metrics.d.ts.map

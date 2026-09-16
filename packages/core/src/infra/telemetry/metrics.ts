/** @module infra/telemetry/metrics — the instrument catalogue, created lazily from a Meter (spec 10 §7). */

import type { Counter, Histogram, Meter, ObservableGauge, UpDownCounter } from '@opentelemetry/api';

/** Instrument names from the catalogue. */
export const METRIC = {
  TOOL_CALLS: 'browserhive.tool_calls',
  TOOL_CALL_DURATION: 'browserhive.tool_call.duration',
  SESSIONS_ACTIVE: 'browserhive.sessions.active',
  SESSION_LAUNCH_DURATION: 'browserhive.session.launch.duration',
  SESSION_LIFETIME: 'browserhive.session.lifetime',
  WS_CONNECTIONS: 'browserhive.ws.connections',
  WS_BUFFERED_BYTES: 'browserhive.ws.buffered_bytes',
  WS_FRAMES_DROPPED: 'browserhive.ws.frames_dropped',
  DB_WRITE_QUEUE_DEPTH: 'browserhive.db.write_queue.depth',
  DB_DROPPED_WRITES: 'browserhive.db.dropped_writes',
  DB_SIZE_BYTES: 'browserhive.db.size_bytes',
  BROWSER_RSS_BYTES: 'browserhive.browser.rss_bytes',
  ATTENTION_OPEN: 'browserhive.attention.open',
  ATTENTION_WAIT: 'browserhive.attention.wait',
  VAULT_FILLS: 'browserhive.vault.fills',
  BLOCKLIST_HITS: 'browserhive.blocklist.hits',
  RETENTION_PRUNED_ROWS: 'browserhive.retention.pruned_rows',
  PROCESS_RSS_BYTES: 'browserhive.process.rss_bytes',
  PROCESS_HEAP_BYTES: 'browserhive.process.heap_bytes',
  PROCESS_EVENT_LOOP_LAG: 'browserhive.process.event_loop_lag',
} as const;

/** Cap on `connection_id` series for the buffered-bytes gauge (spec 10 §7). */
export const WS_BUFFERED_BYTES_MAX_SERIES = 50;

/** Every instrument in the catalogue. Each is created on first access. */
export interface Instruments {
  readonly toolCalls: Counter;
  readonly toolCallDuration: Histogram;
  readonly sessionsActive: UpDownCounter;
  readonly sessionLaunchDuration: Histogram;
  readonly sessionLifetime: Histogram;
  readonly wsConnections: UpDownCounter;
  readonly wsBufferedBytes: ObservableGauge;
  readonly wsFramesDropped: Counter;
  readonly dbWriteQueueDepth: ObservableGauge;
  readonly dbDroppedWrites: Counter;
  readonly dbSizeBytes: ObservableGauge;
  readonly browserRssBytes: ObservableGauge;
  readonly attentionOpen: UpDownCounter;
  readonly attentionWait: Histogram;
  readonly vaultFills: Counter;
  readonly blocklistHits: Counter;
  readonly retentionPrunedRows: Counter;
  readonly processRssBytes: ObservableGauge;
  readonly processHeapBytes: ObservableGauge;
  readonly processEventLoopLag: ObservableGauge;
}

/**
 * Builds the lazily-created {@link Instruments} over `meter`. With telemetry off, `meter` is the
 * API's no-op meter and every instrument is a no-op; the same object backs `/api/v1/system`
 * figures through the counters' owners.
 */
export function createInstruments(meter: Meter): Instruments {
  const cache = new Map<string, unknown>();
  const lazy = <T>(key: string, make: () => T): T => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit as T;
    const made = make();
    cache.set(key, made);
    return made;
  };
  const ms = { unit: 'ms' } as const;
  const bytes = { unit: 'By' } as const;
  return {
    get toolCalls() {
      return lazy(METRIC.TOOL_CALLS, () =>
        meter.createCounter(METRIC.TOOL_CALLS, {
          description: 'Tool calls by tool, ok, error_code',
        }),
      );
    },
    get toolCallDuration() {
      return lazy(METRIC.TOOL_CALL_DURATION, () =>
        meter.createHistogram(METRIC.TOOL_CALL_DURATION, {
          ...ms,
          description: 'Tool call duration',
        }),
      );
    },
    get sessionsActive() {
      return lazy(METRIC.SESSIONS_ACTIVE, () =>
        meter.createUpDownCounter(METRIC.SESSIONS_ACTIVE, {
          description: 'Live sessions by state',
        }),
      );
    },
    get sessionLaunchDuration() {
      return lazy(METRIC.SESSION_LAUNCH_DURATION, () =>
        meter.createHistogram(METRIC.SESSION_LAUNCH_DURATION, {
          ...ms,
          description: 'Session launch duration',
        }),
      );
    },
    get sessionLifetime() {
      return lazy(METRIC.SESSION_LIFETIME, () =>
        meter.createHistogram(METRIC.SESSION_LIFETIME, { ...ms, description: 'Session lifetime' }),
      );
    },
    get wsConnections() {
      return lazy(METRIC.WS_CONNECTIONS, () =>
        meter.createUpDownCounter(METRIC.WS_CONNECTIONS, {
          description: 'Open WebSocket connections',
        }),
      );
    },
    get wsBufferedBytes() {
      return lazy(METRIC.WS_BUFFERED_BYTES, () =>
        meter.createObservableGauge(METRIC.WS_BUFFERED_BYTES, {
          ...bytes,
          description: 'Per-connection buffered bytes',
        }),
      );
    },
    get wsFramesDropped() {
      return lazy(METRIC.WS_FRAMES_DROPPED, () =>
        meter.createCounter(METRIC.WS_FRAMES_DROPPED, { description: 'Frames dropped by channel' }),
      );
    },
    get dbWriteQueueDepth() {
      return lazy(METRIC.DB_WRITE_QUEUE_DEPTH, () =>
        meter.createObservableGauge(METRIC.DB_WRITE_QUEUE_DEPTH, { description: 'Pending writes' }),
      );
    },
    get dbDroppedWrites() {
      return lazy(METRIC.DB_DROPPED_WRITES, () =>
        meter.createCounter(METRIC.DB_DROPPED_WRITES, { description: 'Writes dropped by table' }),
      );
    },
    get dbSizeBytes() {
      return lazy(METRIC.DB_SIZE_BYTES, () =>
        meter.createObservableGauge(METRIC.DB_SIZE_BYTES, {
          ...bytes,
          description: 'Database size',
        }),
      );
    },
    get browserRssBytes() {
      return lazy(METRIC.BROWSER_RSS_BYTES, () =>
        meter.createObservableGauge(METRIC.BROWSER_RSS_BYTES, {
          ...bytes,
          description: 'Browser RSS by session',
        }),
      );
    },
    get attentionOpen() {
      return lazy(METRIC.ATTENTION_OPEN, () =>
        meter.createUpDownCounter(METRIC.ATTENTION_OPEN, {
          description: 'Open operator requests by kind',
        }),
      );
    },
    get attentionWait() {
      return lazy(METRIC.ATTENTION_WAIT, () =>
        meter.createHistogram(METRIC.ATTENTION_WAIT, {
          ...ms,
          description: 'Attention wait by status',
        }),
      );
    },
    get vaultFills() {
      return lazy(METRIC.VAULT_FILLS, () =>
        meter.createCounter(METRIC.VAULT_FILLS, { description: 'Vault fills by result' }),
      );
    },
    get blocklistHits() {
      return lazy(METRIC.BLOCKLIST_HITS, () =>
        meter.createCounter(METRIC.BLOCKLIST_HITS, { description: 'Blocked URLs by source' }),
      );
    },
    get retentionPrunedRows() {
      return lazy(METRIC.RETENTION_PRUNED_ROWS, () =>
        meter.createCounter(METRIC.RETENTION_PRUNED_ROWS, { description: 'Rows pruned by table' }),
      );
    },
    get processRssBytes() {
      return lazy(METRIC.PROCESS_RSS_BYTES, () =>
        meter.createObservableGauge(METRIC.PROCESS_RSS_BYTES, {
          ...bytes,
          description: 'Process RSS',
        }),
      );
    },
    get processHeapBytes() {
      return lazy(METRIC.PROCESS_HEAP_BYTES, () =>
        meter.createObservableGauge(METRIC.PROCESS_HEAP_BYTES, {
          ...bytes,
          description: 'Process heap used',
        }),
      );
    },
    get processEventLoopLag() {
      return lazy(METRIC.PROCESS_EVENT_LOOP_LAG, () =>
        meter.createObservableGauge(METRIC.PROCESS_EVENT_LOOP_LAG, {
          ...ms,
          description: 'Event-loop lag',
        }),
      );
    },
  };
}

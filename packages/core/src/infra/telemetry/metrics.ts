/** @module infra/telemetry/metrics — the instrument catalogue (spec 10 §7, the single source of truth with the docs table), created lazily from a Meter. */

import type {
  Counter,
  Histogram,
  Meter,
  ObservableCounter,
  ObservableGauge,
  ObservableUpDownCounter,
  UpDownCounter,
} from '@opentelemetry/api';

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
  NOTIFICATION_DELIVERIES: 'browserhive.notifications.deliveries',
  NOTIFICATION_ACTIONS: 'browserhive.notifications.actions',
  NOTIFICATION_REPORTS: 'browserhive.notifications.reports',
  PROCESS_RSS_BYTES: 'browserhive.process.rss_bytes',
  PROCESS_HEAP_BYTES: 'browserhive.process.heap_bytes',
  PROCESS_EVENT_LOOP_LAG: 'browserhive.process.event_loop_lag',
} as const;

/** A catalogue name. */
export type MetricName = (typeof METRIC)[keyof typeof METRIC];

/** Cap on `connection_id` series for the buffered-bytes gauge (spec 10 §7). */
export const WS_BUFFERED_BYTES_MAX_SERIES = 50;

/**
 * The recorder tables of the write queue (spec 10 §7 `browserhive.db.dropped_writes{table}`): each
 * is reported from the start, at 0 until it loses a write, so a rate over the series works.
 */
export const DB_WRITE_TABLES = [
  'sessions',
  'tool_calls',
  'pages',
  'screenshots',
  'blocked_requests',
  'vault_access',
  'events',
  'logs',
] as const;

/** How often the browser-memory sampler reads the process trees (spec 10 §7). */
export const BROWSER_RSS_SAMPLE_INTERVAL_MS = 10_000;

/** The OTLP data a collector receives: a monotonic sum, a non-monotonic sum, a histogram, a gauge. */
export type MetricKind = 'counter' | 'up-down counter' | 'histogram' | 'gauge';

/** One row of the spec 10 §7 table. */
export interface MetricDefinition {
  readonly name: MetricName;
  readonly kind: MetricKind;
  /** Read by a callback at each export rather than written per event. */
  readonly observable: boolean;
  /** UCUM unit (`ms`, `By`) or a `{annotation}` count. */
  readonly unit: string;
  /** Every attribute key a data point may carry. */
  readonly attributes: readonly string[];
  readonly description: string;
}

const def = (
  name: MetricName,
  kind: MetricKind,
  unit: string,
  attributes: readonly string[],
  description: string,
  observable = false,
): MetricDefinition => ({ name, kind, observable, unit, attributes, description });

/** The catalogue, in the order of the spec 10 §7 table. */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  def(
    METRIC.TOOL_CALLS,
    'counter',
    '{call}',
    ['tool', 'ok', 'error_code', 'harness'],
    'Tool calls by tool, ok, error_code and harness',
  ),
  def(METRIC.TOOL_CALL_DURATION, 'histogram', 'ms', ['tool'], 'Tool call duration'),
  def(METRIC.SESSIONS_ACTIVE, 'up-down counter', '{session}', ['harness'], 'Live sessions'),
  def(
    METRIC.SESSION_LAUNCH_DURATION,
    'histogram',
    'ms',
    ['channel', 'stealth'],
    'Create request to browser attached, per successful launch',
  ),
  def(METRIC.SESSION_LIFETIME, 'histogram', 'ms', ['closed_reason'], 'Session lifetime'),
  def(
    METRIC.WS_CONNECTIONS,
    'up-down counter',
    '{connection}',
    [],
    'Open WebSocket connections',
    true,
  ),
  def(
    METRIC.WS_BUFFERED_BYTES,
    'gauge',
    'By',
    ['connection_id'],
    'Per-connection buffered bytes',
    true,
  ),
  def(
    METRIC.WS_FRAMES_DROPPED,
    'counter',
    '{frame}',
    ['channel'],
    'Frames dropped by channel',
    true,
  ),
  def(METRIC.DB_WRITE_QUEUE_DEPTH, 'gauge', '{write}', [], 'Pending writes', true),
  def(METRIC.DB_DROPPED_WRITES, 'counter', '{write}', ['table'], 'Writes dropped by table', true),
  def(METRIC.DB_SIZE_BYTES, 'gauge', 'By', [], 'Database size', true),
  def(
    METRIC.BROWSER_RSS_BYTES,
    'gauge',
    'By',
    ['session_id'],
    'Browser process-tree RSS by session',
    true,
  ),
  def(
    METRIC.ATTENTION_OPEN,
    'up-down counter',
    '{request}',
    ['kind'],
    'Open operator requests by kind',
  ),
  def(METRIC.ATTENTION_WAIT, 'histogram', 'ms', ['status'], 'Attention wait by status'),
  def(METRIC.VAULT_FILLS, 'counter', '{fill}', ['result'], 'Vault fills by result'),
  def(METRIC.BLOCKLIST_HITS, 'counter', '{hit}', ['source'], 'Blocked URLs by source'),
  def(METRIC.RETENTION_PRUNED_ROWS, 'counter', '{row}', ['table'], 'Rows pruned by table'),
  def(
    METRIC.NOTIFICATION_DELIVERIES,
    'counter',
    '{delivery}',
    ['channel_kind', 'status'],
    'Notification deliveries by channel_kind and status',
  ),
  def(
    METRIC.NOTIFICATION_REPORTS,
    'counter',
    '{report}',
    ['kind', 'outcome'],
    'Scheduled report decisions by kind and outcome',
  ),
  def(
    METRIC.NOTIFICATION_ACTIONS,
    'counter',
    '{press}',
    ['channel_kind', 'outcome'],
    'Act-button presses by channel_kind and outcome',
  ),
  def(METRIC.PROCESS_RSS_BYTES, 'gauge', 'By', [], 'Process RSS', true),
  def(METRIC.PROCESS_HEAP_BYTES, 'gauge', 'By', [], 'Process heap used', true),
  def(
    METRIC.PROCESS_EVENT_LOOP_LAG,
    'gauge',
    'ms',
    [],
    'Event-loop delay, p99 since the previous export',
    true,
  ),
];

/** Every instrument in the catalogue. Each is created on first access. */
export interface Instruments {
  readonly toolCalls: Counter;
  readonly toolCallDuration: Histogram;
  readonly sessionsActive: UpDownCounter;
  readonly sessionLaunchDuration: Histogram;
  readonly sessionLifetime: Histogram;
  readonly wsConnections: ObservableUpDownCounter;
  readonly wsBufferedBytes: ObservableGauge;
  readonly wsFramesDropped: ObservableCounter;
  readonly dbWriteQueueDepth: ObservableGauge;
  readonly dbDroppedWrites: ObservableCounter;
  readonly dbSizeBytes: ObservableGauge;
  readonly browserRssBytes: ObservableGauge;
  readonly attentionOpen: UpDownCounter;
  readonly attentionWait: Histogram;
  readonly vaultFills: Counter;
  readonly blocklistHits: Counter;
  readonly retentionPrunedRows: Counter;
  /** Outbox jobs by `channel_kind` and `status` (D-34). */
  readonly notificationDeliveries: Counter;
  /** Act-button presses by `channel_kind` and `outcome` (D-41). */
  readonly notificationActions: Counter;
  /** Scheduled report decisions by `kind` and `outcome` (D-43, D-44). */
  readonly notificationReports: Counter;
  readonly processRssBytes: ObservableGauge;
  readonly processHeapBytes: ObservableGauge;
  readonly processEventLoopLag: ObservableGauge;
}

interface InstrumentOptions {
  readonly unit: string;
  readonly description: string;
}

/**
 * Builds the lazily-created {@link Instruments} over `meter`, each with the name, unit and
 * description of its {@link METRIC_DEFINITIONS} row. With telemetry off, `meter` is the API's
 * no-op meter and every instrument is a no-op.
 */
export function createInstruments(meter: Meter): Instruments {
  const cache = new Map<string, unknown>();
  const byName = new Map(METRIC_DEFINITIONS.map((d) => [d.name, d]));
  const lazy = <T>(name: MetricName, make: (options: InstrumentOptions) => T): T => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit as T;
    const d = byName.get(name);
    if (d === undefined) throw new Error(`metric ${name} is not in the catalogue`);
    const made = make({ unit: d.unit, description: d.description });
    cache.set(name, made);
    return made;
  };
  const counter = (name: MetricName) => lazy(name, (o) => meter.createCounter(name, o));
  const upDown = (name: MetricName) => lazy(name, (o) => meter.createUpDownCounter(name, o));
  const histogram = (name: MetricName) => lazy(name, (o) => meter.createHistogram(name, o));
  const gauge = (name: MetricName) => lazy(name, (o) => meter.createObservableGauge(name, o));
  const observableCounter = (name: MetricName) =>
    lazy(name, (o) => meter.createObservableCounter(name, o));
  const observableUpDown = (name: MetricName) =>
    lazy(name, (o) => meter.createObservableUpDownCounter(name, o));
  return {
    get toolCalls() {
      return counter(METRIC.TOOL_CALLS);
    },
    get toolCallDuration() {
      return histogram(METRIC.TOOL_CALL_DURATION);
    },
    get sessionsActive() {
      return upDown(METRIC.SESSIONS_ACTIVE);
    },
    get sessionLaunchDuration() {
      return histogram(METRIC.SESSION_LAUNCH_DURATION);
    },
    get sessionLifetime() {
      return histogram(METRIC.SESSION_LIFETIME);
    },
    get wsConnections() {
      return observableUpDown(METRIC.WS_CONNECTIONS);
    },
    get wsBufferedBytes() {
      return gauge(METRIC.WS_BUFFERED_BYTES);
    },
    get wsFramesDropped() {
      return observableCounter(METRIC.WS_FRAMES_DROPPED);
    },
    get dbWriteQueueDepth() {
      return gauge(METRIC.DB_WRITE_QUEUE_DEPTH);
    },
    get dbDroppedWrites() {
      return observableCounter(METRIC.DB_DROPPED_WRITES);
    },
    get dbSizeBytes() {
      return gauge(METRIC.DB_SIZE_BYTES);
    },
    get browserRssBytes() {
      return gauge(METRIC.BROWSER_RSS_BYTES);
    },
    get attentionOpen() {
      return upDown(METRIC.ATTENTION_OPEN);
    },
    get attentionWait() {
      return histogram(METRIC.ATTENTION_WAIT);
    },
    get vaultFills() {
      return counter(METRIC.VAULT_FILLS);
    },
    get blocklistHits() {
      return counter(METRIC.BLOCKLIST_HITS);
    },
    get retentionPrunedRows() {
      return counter(METRIC.RETENTION_PRUNED_ROWS);
    },
    get notificationDeliveries() {
      return counter(METRIC.NOTIFICATION_DELIVERIES);
    },
    get notificationActions() {
      return counter(METRIC.NOTIFICATION_ACTIONS);
    },
    get notificationReports() {
      return counter(METRIC.NOTIFICATION_REPORTS);
    },
    get processRssBytes() {
      return gauge(METRIC.PROCESS_RSS_BYTES);
    },
    get processHeapBytes() {
      return gauge(METRIC.PROCESS_HEAP_BYTES);
    },
    get processEventLoopLag() {
      return gauge(METRIC.PROCESS_EVENT_LOOP_LAG);
    },
  };
}

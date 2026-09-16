/** @module infra/telemetry/telemetry — `createTelemetry`: OTel API no-ops when off; SDK providers + OTLP exporters when on (spec 10 §8, D-08). */

import {
  type Meter,
  metrics,
  context as otelContext,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { logs, type Logger as OtelLogger } from '@opentelemetry/api-logs';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { createInstruments, type Instruments } from './metrics.ts';
import { TRACER_NAME } from './spans.ts';

/** OTLP/HTTP encodings. */
export type OtelProtocol = 'http/protobuf' | 'http/json';

/** One of the three exported signals. */
export type OtelSignal = 'traces' | 'metrics' | 'logs';

/** Default OTLP/HTTP base endpoint. */
export const DEFAULT_OTEL_ENDPOINT = 'http://127.0.0.1:4318';

/** Default metrics export interval. */
export const DEFAULT_METRICS_INTERVAL_MS = 30_000;

/** Consecutive export failures before `onDegraded` fires. */
export const DEFAULT_DEGRADED_AFTER = 5;

/** Reported through `onDegraded` when a signal's exporter keeps failing, and once when it recovers. */
export interface TelemetryDegradation {
  readonly signal: OtelSignal;
  readonly consecutiveFailures: number;
  readonly error: unknown;
  /** `true` on the first successful export after a reported degradation. */
  readonly recovered: boolean;
}

/** Options for {@link createTelemetry}; mirror the `otel*` config keys (spec 08 §5.3). */
export interface TelemetryOptions {
  readonly enabled: boolean;
  /** OTLP/HTTP base; `/v1/traces`, `/v1/metrics`, `/v1/logs` are appended. */
  readonly endpoint?: string;
  readonly protocol?: OtelProtocol;
  /** Secret; never logged. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  /** `service.instance.id` (data-dir instance id). */
  readonly instanceId?: string;
  readonly hostName?: string;
  readonly osType?: string;
  /** `browserhive.transport` resource attribute. */
  readonly transport?: string;
  /** Parent-based ratio sampler argument, 0–1. Default 1. */
  readonly sampleRatio?: number;
  /** Signals to export; default all three. */
  readonly signals?: {
    readonly traces?: boolean;
    readonly metrics?: boolean;
    readonly logs?: boolean;
  };
  readonly metricsIntervalMs?: number;
  /** Per-export HTTP timeout. */
  readonly exportTimeoutMs?: number;
  readonly degradedAfter?: number;
  readonly onDegraded?: (event: TelemetryDegradation) => void;
  /** Register the providers/context manager globally so `withSpan` and the logger see them. Default `true`. */
  readonly registerGlobals?: boolean;
}

/** What the composition root and services receive. */
export interface Telemetry {
  readonly enabled: boolean;
  readonly tracer: Tracer;
  readonly meter: Meter;
  /** `api-logs` Logger for the OTel log sink. */
  readonly logsBridge: OtelLogger;
  /** Lazily created instrument catalogue over `meter`. */
  readonly instruments: Instruments;
  /** Pushes buffered spans/metrics/logs. Never rejects. */
  forceFlush(): Promise<void>;
  /** Flushes, shuts the providers down and restores the API no-ops. Idempotent; never rejects. */
  shutdown(signal?: AbortSignal): Promise<void>;
}

/**
 * Builds the {@link Telemetry} handle. When disabled nothing from the SDK is imported and the
 * OTel API's no-op tracer/meter/logger are returned (negligible overhead, probe 4). When enabled
 * the SDK modules are imported dynamically and wired with OTLP/HTTP exporters.
 */
export async function createTelemetry(options: TelemetryOptions): Promise<Telemetry> {
  if (!options.enabled) return noopTelemetry();
  return enabledTelemetry(options);
}

function noopTelemetry(): Telemetry {
  const meter = metrics.getMeter(TRACER_NAME);
  return {
    enabled: false,
    tracer: trace.getTracer(TRACER_NAME),
    meter,
    logsBridge: logs.getLogger(TRACER_NAME),
    instruments: createInstruments(meter),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

interface Shutdownable {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

async function enabledTelemetry(options: TelemetryOptions): Promise<Telemetry> {
  const protocol = options.protocol ?? 'http/protobuf';
  const endpoint = (options.endpoint ?? DEFAULT_OTEL_ENDPOINT).replace(/\/+$/, '');
  const signals = { traces: true, metrics: true, logs: true, ...options.signals };
  const tracker = createFailureTracker(options);
  const exporterConfig = (
    path: string,
  ): { url: string; headers: Record<string, string>; timeoutMillis: number } => ({
    url: `${endpoint}${path}`,
    headers: { ...options.headers },
    timeoutMillis: options.exportTimeoutMs ?? 10_000,
  });

  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const resource = resourceFromAttributes({
    'service.name': options.serviceName ?? 'browserhive',
    ...(options.serviceVersion !== undefined && { 'service.version': options.serviceVersion }),
    ...(options.instanceId !== undefined && { 'service.instance.id': options.instanceId }),
    ...(options.hostName !== undefined && { 'host.name': options.hostName }),
    ...(options.osType !== undefined && { 'os.type': options.osType }),
    ...(options.transport !== undefined && { 'browserhive.transport': options.transport }),
  });

  const providers: Shutdownable[] = [];
  const registerGlobals = options.registerGlobals ?? true;

  if (registerGlobals) {
    const { AsyncLocalStorageContextManager } = await import('@opentelemetry/context-async-hooks');
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  }

  let tracer: Tracer = trace.getTracer(TRACER_NAME);
  if (signals.traces) {
    const sdk = await import('@opentelemetry/sdk-trace-base');
    const { OTLPTraceExporter } =
      protocol === 'http/json'
        ? await import('@opentelemetry/exporter-trace-otlp-http')
        : await import('@opentelemetry/exporter-trace-otlp-proto');
    const exporter = trackSpanExporter(
      new OTLPTraceExporter(exporterConfig('/v1/traces')),
      tracker,
    );
    const ratio = clampRatio(options.sampleRatio ?? 1);
    const provider = new sdk.BasicTracerProvider({
      resource,
      sampler: new sdk.ParentBasedSampler({ root: new sdk.TraceIdRatioBasedSampler(ratio) }),
      spanProcessors: [new sdk.BatchSpanProcessor(exporter)],
    });
    providers.push(provider);
    if (registerGlobals) trace.setGlobalTracerProvider(provider);
    tracer = registerGlobals ? trace.getTracer(TRACER_NAME) : provider.getTracer(TRACER_NAME);
  }

  let meter: Meter = metrics.getMeter(TRACER_NAME);
  if (signals.metrics) {
    const sdk = await import('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } =
      protocol === 'http/json'
        ? await import('@opentelemetry/exporter-metrics-otlp-http')
        : await import('@opentelemetry/exporter-metrics-otlp-proto');
    const exporter = trackMetricExporter(
      new OTLPMetricExporter(exporterConfig('/v1/metrics')),
      tracker,
    );
    const provider = new sdk.MeterProvider({
      resource,
      readers: [
        new sdk.PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: options.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS,
        }),
      ],
    });
    providers.push(provider);
    if (registerGlobals) metrics.setGlobalMeterProvider(provider);
    meter = registerGlobals ? metrics.getMeter(TRACER_NAME) : provider.getMeter(TRACER_NAME);
  }

  let logsBridge: OtelLogger = logs.getLogger(TRACER_NAME);
  if (signals.logs) {
    const sdk = await import('@opentelemetry/sdk-logs');
    const { OTLPLogExporter } =
      protocol === 'http/json'
        ? await import('@opentelemetry/exporter-logs-otlp-http')
        : await import('@opentelemetry/exporter-logs-otlp-proto');
    const exporter = trackLogExporter(new OTLPLogExporter(exporterConfig('/v1/logs')), tracker);
    const provider = new sdk.LoggerProvider({
      resource,
      processors: [new sdk.BatchLogRecordProcessor({ exporter })],
    });
    providers.push(provider);
    if (registerGlobals) logs.setGlobalLoggerProvider(provider);
    logsBridge = registerGlobals ? logs.getLogger(TRACER_NAME) : provider.getLogger(TRACER_NAME);
  }

  let stopped = false;
  const forceFlush = async (): Promise<void> => {
    await Promise.allSettled(providers.map((p) => p.forceFlush()));
  };
  return {
    enabled: true,
    tracer,
    meter,
    logsBridge,
    instruments: createInstruments(meter),
    forceFlush,
    async shutdown(signal) {
      if (stopped) return;
      stopped = true;
      const work = (async () => {
        await forceFlush();
        await Promise.allSettled(providers.map((p) => p.shutdown()));
      })();
      await (signal === undefined ? work : raceAbort(work, signal));
      if (registerGlobals) {
        trace.disable();
        metrics.disable();
        logs.disable();
        otelContext.disable();
      }
    },
  };
}

/** Result shape shared by the three exporter kinds (`@opentelemetry/core` ExportResult). */
interface ExportOutcome {
  readonly code: number;
  readonly error?: Error;
}

/** `ExportResultCode.SUCCESS`. */
const EXPORT_SUCCESS = 0;

interface FailureTracker {
  record(signal: OtelSignal, result: ExportOutcome): void;
}

function createFailureTracker(options: TelemetryOptions): FailureTracker {
  const threshold = Math.max(1, options.degradedAfter ?? DEFAULT_DEGRADED_AFTER);
  const counts = new Map<OtelSignal, number>();
  const reported = new Set<OtelSignal>();
  const notify = (event: TelemetryDegradation): void => {
    try {
      options.onDegraded?.(event);
    } catch {
      // The degradation reporter itself failed; export continues regardless.
    }
  };
  return {
    record(signal, result) {
      if (result.code === EXPORT_SUCCESS) {
        counts.set(signal, 0);
        if (reported.delete(signal)) {
          notify({ signal, consecutiveFailures: 0, error: undefined, recovered: true });
        }
        return;
      }
      const next = (counts.get(signal) ?? 0) + 1;
      counts.set(signal, next);
      if (next >= threshold && !reported.has(signal)) {
        reported.add(signal);
        notify({ signal, consecutiveFailures: next, error: result.error, recovered: false });
      }
    },
  };
}

function trackSpanExporter(inner: SpanExporter, tracker: FailureTracker): SpanExporter {
  return {
    export: (items, cb) =>
      inner.export(items, (result) => {
        tracker.record('traces', result);
        cb(result);
      }),
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}

function trackMetricExporter(
  inner: PushMetricExporter,
  tracker: FailureTracker,
): PushMetricExporter {
  const wrapped: PushMetricExporter = {
    export: (items, cb) =>
      inner.export(items, (result) => {
        tracker.record('metrics', result);
        cb(result);
      }),
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
  const temporality = inner.selectAggregationTemporality?.bind(inner);
  const aggregation = inner.selectAggregation?.bind(inner);
  return {
    ...wrapped,
    ...(temporality !== undefined && { selectAggregationTemporality: temporality }),
    ...(aggregation !== undefined && { selectAggregation: aggregation }),
  };
}

function trackLogExporter(inner: LogRecordExporter, tracker: FailureTracker): LogRecordExporter {
  return {
    export: (items, cb) =>
      inner.export(items, (result) => {
        tracker.record('logs', result);
        cb(result);
      }),
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(1, Math.max(0, ratio));
}

function raceAbort(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    work.then(done, done);
  });
}

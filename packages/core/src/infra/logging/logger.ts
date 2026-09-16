/** @module infra/logging/logger — `createLogger`: the production Logger port with child bindings, per-module levels, context stamping and sinks (spec 10 §4). */

import { isSpanContextValid, context as otelContext, trace } from '@opentelemetry/api';
import { currentRequestContext, type RequestContext } from '../../kernel/context.ts';
import { createRedactor, type Redactor } from '../../kernel/redact.ts';
import type { Clock } from '../../ports/clock.ts';
import type { LogFields, Logger, LogLevel } from '../../ports/logger.ts';
import { renderJson } from './json-renderer.ts';
import { effectiveLevel, type LevelSpec, levelEnabled, toLevelSpec } from './level-spec.ts';
import { renderPretty } from './pretty-renderer.ts';
import { buildLogRecord, type LogRecord, type TraceIds } from './record.ts';
import type { LogRingBuffer } from './ring-buffer.ts';
import {
  type FanOutSink,
  fanOutSink,
  type LineStream,
  type LogSink,
  ringSink,
  type SinkFailure,
  streamSink,
} from './sinks.ts';

/** Output renderer. `auto` is resolved by the composition root before calling `createLogger`. */
export type LogFormat = 'json' | 'pretty';

/** Options for {@link createLogger}. */
export interface CreateLoggerOptions {
  /** Threshold(s): a bare level or a parsed spec (`parseLevelSpec`). */
  readonly level: LogLevel | LevelSpec;
  readonly format: LogFormat;
  /** Time source for `ts`. */
  readonly clock: Clock;
  /** Primary destination (stdout/stderr per spec 10 §4.3). Omit for ring/collecting-only loggers. */
  readonly stream?: LineStream;
  /** Emit ANSI colour in pretty mode (resolved via `resolveColor`). Default `false`. */
  readonly color?: boolean;
  /** Terminal width for pretty wrapping. */
  readonly width?: number;
  /** In-process ring buffer fed by every record (including `trace`). */
  readonly ringBuffer?: LogRingBuffer;
  /** Redaction pipeline; defaults to key heuristics + patterns only (no registry). */
  readonly redactor?: Redactor;
  /** Request-context source; defaults to `currentRequestContext`. */
  readonly context?: () => RequestContext | undefined;
  /** Active-span source; defaults to the OTel API's active span. */
  readonly traceIds?: () => TraceIds | undefined;
  /** Additional sinks (OTel logs bridge, durable table). */
  readonly sinks?: readonly LogSink[];
  /** Query keys kept by the `url` serializer (`--urlQueryAllowlist`). */
  readonly urlQueryAllowlist?: readonly string[];
  /** Bindings merged into every record from the root (`transport`, …). */
  readonly bindings?: LogFields;
  /** Called when a sink is disabled after repeated failures (feeds `system.degraded`). */
  readonly onSinkDisabled?: (failure: SinkFailure) => void;
  /** Let `trace` records reach the stream and extra sinks (`--otelVerbose`). Default: ring only. */
  readonly traceLeavesRing?: boolean;
}

/** The root logger: a `Logger` plus runtime controls owned by the composition root. */
export interface RootLogger extends Logger {
  /** Replaces the level spec at runtime (`PATCH /system/log-level`, `SIGUSR2`). */
  setLevel(level: LogLevel | LevelSpec): void;
  /** The current level spec. */
  getLevel(): LevelSpec;
  /** Adds a sink at runtime (OTel bridge created after boot). */
  addSink(sink: LogSink): void;
  /** Removes a sink by name. */
  removeSink(name: string): void;
  /** Flushes every sink. Never rejects. */
  flush(): Promise<void>;
}

interface Core {
  spec: LevelSpec;
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly context: () => RequestContext | undefined;
  readonly traceIds: () => TraceIds | undefined;
  readonly urlQueryAllowlist: readonly string[];
  readonly ring: LogSink | undefined;
  readonly fanOut: FanOutSink;
  readonly traceLeavesRing: boolean;
}

/**
 * Builds the production {@link RootLogger}. Records are built once, redacted, then delivered
 * to the ring buffer (all levels) and the fan-out (stream + extra sinks; `trace` only when
 * `traceLeavesRing`). A log call never throws.
 */
export function createLogger(options: CreateLoggerOptions): RootLogger {
  const redactor = options.redactor ?? createRedactor();
  const scrubLine = (line: string): string => redactor.scrubText(line);
  const render =
    options.format === 'pretty'
      ? (record: LogRecord): string =>
          renderPretty(record, {
            color: options.color ?? false,
            ...(options.width !== undefined && { width: options.width }),
          })
      : (record: LogRecord): string => renderJson(record, scrubLine);

  const sinks: LogSink[] = [];
  if (options.stream !== undefined) sinks.push(streamSink('stream', options.stream, render));
  sinks.push(...(options.sinks ?? []));

  const core: Core = {
    spec: toLevelSpec(options.level),
    clock: options.clock,
    redactor,
    context: options.context ?? currentRequestContext,
    traceIds: options.traceIds ?? activeSpanIds,
    urlQueryAllowlist: options.urlQueryAllowlist ?? [],
    ring: options.ringBuffer !== undefined ? ringSink(options.ringBuffer) : undefined,
    fanOut: fanOutSink(sinks, {
      ...(options.onSinkDisabled !== undefined && { onSinkDisabled: options.onSinkDisabled }),
    }),
    traceLeavesRing: options.traceLeavesRing ?? false,
  };

  const root = makeLogger(core, options.bindings ?? {});
  return {
    ...root,
    setLevel(level) {
      core.spec = toLevelSpec(level);
    },
    getLevel() {
      return core.spec;
    },
    addSink(sink) {
      core.fanOut.add(sink);
    },
    removeSink(name) {
      core.fanOut.remove(name);
    },
    async flush() {
      await core.fanOut.flushAll();
    },
  };
}

function makeLogger(core: Core, bindings: LogFields): Logger {
  const module = moduleOf(bindings);
  const emit = (level: LogLevel, msg: string, fields: LogFields | undefined): void => {
    try {
      if (!levelEnabled(effectiveLevel(core.spec, module), level)) return;
      const record = buildLogRecord({
        ts: core.clock.now(),
        level,
        msg,
        fields: fields === undefined ? bindings : { ...bindings, ...fields },
        context: core.context(),
        traceIds: core.traceIds(),
        urlQueryAllowlist: core.urlQueryAllowlist,
        redactValue: (value) => core.redactor.redactValue(value),
        scrubText: (text) => core.redactor.scrubText(text),
      });
      core.ring?.write(record);
      if (level !== 'trace' || core.traceLeavesRing) core.fanOut.write(record);
    } catch {
      // A logging failure must never surface to the caller (spec 10 §4.3).
    }
  };
  return {
    child(extra) {
      return makeLogger(core, { ...bindings, ...extra });
    },
    isLevelEnabled(level) {
      return levelEnabled(effectiveLevel(core.spec, module), level);
    },
    error: (msg, fields) => emit('error', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    trace: (msg, fields) => emit('trace', msg, fields),
  };
}

function moduleOf(bindings: LogFields): string | undefined {
  const value = bindings['module'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Trace/span ids of the active OTel span when one exists and is valid. */
export function activeSpanIds(): TraceIds | undefined {
  const span = trace.getSpan(otelContext.active());
  if (span === undefined) return undefined;
  const ctx = span.spanContext();
  return isSpanContextValid(ctx) ? { traceId: ctx.traceId, spanId: ctx.spanId } : undefined;
}

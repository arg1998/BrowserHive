/** @module infra/telemetry/otel-log-sink — logger sink that forwards records to the OTel logs API (spec 10 §4.3, §8). */

import type { LogAttributes, Logger as OtelLogger } from '@opentelemetry/api-logs';
import { SeverityNumber } from '@opentelemetry/api-logs';
import type { LogLevel } from '../../ports/logger.ts';
import type { LogRecord } from '../logging/record.ts';
import type { LogSink } from '../logging/sinks.ts';

/** OTel severity numbers per level (the `*` base value of each band). */
export const SEVERITY: Readonly<Record<LogLevel, SeverityNumber>> = {
  error: SeverityNumber.ERROR,
  warn: SeverityNumber.WARN,
  info: SeverityNumber.INFO,
  debug: SeverityNumber.DEBUG,
  trace: SeverityNumber.TRACE,
};

/** Record keys that become the body/severity/timestamp rather than attributes. */
const STRUCTURAL_KEYS: readonly string[] = ['ts', 'level', 'msg'];

/**
 * Builds a {@link LogSink} that emits each record through `logger` (an `api-logs` Logger from
 * `createTelemetry().logsBridge`). Nested values are JSON-encoded; `err` is flattened to
 * `exception.type` / `exception.message` / `exception.stacktrace`.
 */
export function createOtelLogSink(logger: OtelLogger, name = 'otel'): LogSink {
  return {
    name,
    write(record) {
      logger.emit({
        timestamp: record.ts,
        severityNumber: SEVERITY[record.level],
        severityText: record.level.toUpperCase(),
        body: record.msg,
        attributes: toAttributes(record),
      });
    },
  };
}

/** Flattens a record into OTel log attributes. Exported for tests. */
export function toAttributes(record: LogRecord): LogAttributes {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    if (STRUCTURAL_KEYS.includes(key) || value === undefined || value === null) continue;
    if (key === 'err' && typeof value === 'object') {
      const err = value as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
      if (typeof err.name === 'string') out['exception.type'] = err.name;
      if (typeof err.message === 'string') out['exception.message'] = err.message;
      if (typeof err.stack === 'string') out['exception.stacktrace'] = err.stack;
      if (typeof err.code === 'string') out['exception.code'] = err.code;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    try {
      out[key] = JSON.stringify(value) ?? '';
    } catch {
      out[key] = '[unserializable]';
    }
  }
  return out;
}

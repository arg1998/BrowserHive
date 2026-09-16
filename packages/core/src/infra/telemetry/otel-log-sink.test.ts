/** @module infra/telemetry/otel-log-sink.test — records become OTel log records with severities and flattened attributes. */

import { describe, expect, it } from 'bun:test';
import type { LogRecord as OtelLogRecord } from '@opentelemetry/api-logs';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { createOtelLogSink, SEVERITY, toAttributes } from './otel-log-sink.ts';

describe('createOtelLogSink', () => {
  it('emits body, severity, timestamp and attributes', () => {
    const emitted: OtelLogRecord[] = [];
    const sink = createOtelLogSink({ emit: (r) => void emitted.push(r), enabled: () => true });
    sink.write({
      ts: 1_000,
      level: 'warn',
      msg: 'tool call failed',
      module: 'mcp',
      trace_id: 't',
      session_id: 's-1',
      nested: { a: 1 },
      none: null,
      err: { name: 'AppError', message: 'boom', code: 'X', stack: 'AppError: boom' },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      timestamp: 1_000,
      severityNumber: SeverityNumber.WARN,
      severityText: 'WARN',
      body: 'tool call failed',
      attributes: {
        module: 'mcp',
        trace_id: 't',
        session_id: 's-1',
        nested: '{"a":1}',
        'exception.type': 'AppError',
        'exception.message': 'boom',
        'exception.code': 'X',
        'exception.stacktrace': 'AppError: boom',
      },
    });
    expect(sink.name).toBe('otel');
  });

  it('maps every level to a severity band', () => {
    expect(SEVERITY).toEqual({
      error: SeverityNumber.ERROR,
      warn: SeverityNumber.WARN,
      info: SeverityNumber.INFO,
      debug: SeverityNumber.DEBUG,
      trace: SeverityNumber.TRACE,
    });
    expect(toAttributes({ ts: 1, level: 'info', msg: 'x', module: 'm' })).toEqual({ module: 'm' });
  });
});

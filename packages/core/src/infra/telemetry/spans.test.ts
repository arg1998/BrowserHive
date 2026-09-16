/** @module infra/telemetry/spans.test — probe: nested startActiveSpan is parent/child under Bun; withSpan error semantics; traceparent. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { context as otelContext, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { AppError } from '../../kernel/errors/app-error.ts';
import { activeSpanIds } from '../logging/logger.ts';
import {
  ATTR,
  formatTraceparent,
  getTracer,
  parseTraceparent,
  withSpan,
  withSpanSync,
} from './spans.ts';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  otelContext.disable();
});

describe('probe: nested spans under Bun', () => {
  it('produces parent/child ids across awaits', async () => {
    exporter.reset();
    await withSpan('parent', { [ATTR.TOOL]: 'navigate' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      await withSpan('child', {}, async () => {
        await Promise.resolve();
        expect(activeSpanIds()).toBeDefined();
      });
    });
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === 'parent');
    const child = spans.find((s) => s.name === 'child');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId ?? '');
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId ?? '');
    expect(parent?.attributes[ATTR.TOOL]).toBe('navigate');
  });

  it('the logger reads the active span ids', async () => {
    await withSpan('log-me', {}, async (span) => {
      expect(activeSpanIds()).toEqual({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
      });
    });
    expect(activeSpanIds()).toBeUndefined();
  });
});

describe('withSpan', () => {
  it('marks failures with ok=false, error_code and ERROR status, then rethrows', async () => {
    exporter.reset();
    const error = new AppError('URL_BLOCKED', { url: 'https://x', pattern: '*x*' });
    await expect(
      withSpan('fail', { skipped: undefined, kept: 1 }, () => Promise.reject(error)),
    ).rejects.toBe(error);
    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes[ATTR.OK]).toBe(false);
    expect(span?.attributes[ATTR.ERROR_CODE]).toBe('URL_BLOCKED');
    expect(span?.attributes['kept']).toBe(1);
    expect(span?.attributes['skipped']).toBeUndefined();
    expect(span?.status.code).toBe(2);
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('withSpanSync returns the value and ends the span', () => {
    exporter.reset();
    expect(withSpanSync('sync', {}, () => 42, { tracer: getTracer() })).toBe(42);
    expect(exporter.getFinishedSpans()[0]?.name).toBe('sync');
  });
});

describe('traceparent', () => {
  it('parses and formats version-00 headers', () => {
    const header = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    expect(parseTraceparent(header)).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      sampled: true,
    });
    expect(formatTraceparent('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331')).toBe(header);
    expect(parseTraceparent('00-00000000000000000000000000000000-b7ad6b7169203331-01')).toBeNull();
    expect(parseTraceparent('ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });
});

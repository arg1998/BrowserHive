/** @module infra/telemetry/telemetry.test — disabled telemetry is the API no-op; enabled telemetry wires the SDK and reports export failures. */

import { afterEach, describe, expect, it } from 'bun:test';
import { trace } from '@opentelemetry/api';
import { activeSpanIds } from '../logging/logger.ts';
import { withSpan } from './spans.ts';
import { createTelemetry, type Telemetry, type TelemetryDegradation } from './telemetry.ts';

let handle: Telemetry | undefined;

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
});

describe('createTelemetry (disabled)', () => {
  it('returns no-op API objects and never registers a provider', async () => {
    handle = await createTelemetry({ enabled: false });
    expect(handle.enabled).toBe(false);
    await withSpan('noop', {}, async (span) => {
      expect(span.isRecording()).toBe(false);
      expect(activeSpanIds()).toBeUndefined();
    });
    handle.instruments.toolCalls.add(1);
    handle.logsBridge.emit({ body: 'x' });
    await expect(handle.forceFlush()).resolves.toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe('createTelemetry (enabled)', () => {
  it('registers a real tracer, propagates context, and reports export failures then shutdown restores no-ops', async () => {
    const events: TelemetryDegradation[] = [];
    handle = await createTelemetry({
      enabled: true,
      // Nothing listens on this port: every export fails fast with ECONNREFUSED.
      endpoint: 'http://127.0.0.1:9/',
      protocol: 'http/json',
      headers: { Authorization: 'Bearer test' },
      serviceName: 'browserhive-test',
      serviceVersion: '0.0.0',
      instanceId: 'inst-1',
      hostName: 'h',
      osType: 'linux',
      transport: 'http',
      sampleRatio: 1,
      signals: { traces: true, metrics: false, logs: true },
      exportTimeoutMs: 2_000,
      degradedAfter: 1,
      onDegraded: (e) => events.push(e),
    });
    expect(handle.enabled).toBe(true);

    let ids: { traceId: string; spanId: string } | undefined;
    await withSpan('parent', {}, async () => {
      ids = activeSpanIds();
      await withSpan('child', {}, async (child) => {
        expect(child.isRecording()).toBe(true);
        expect(child.spanContext().traceId).toBe(ids?.traceId ?? '');
      });
    });
    expect(ids).toBeDefined();
    expect(trace.getTracerProvider()).toBeDefined();

    handle.logsBridge.emit({ body: 'hello', attributes: { a: 1 } });
    await handle.forceFlush();
    await handle.shutdown();

    const signals = new Set(events.map((e) => e.signal));
    expect(signals.has('traces')).toBe(true);
    expect(signals.has('logs')).toBe(true);
    for (const event of events) {
      expect(event.recovered).toBe(false);
      expect(event.consecutiveFailures).toBeGreaterThanOrEqual(1);
    }
    // Globals are restored: spans are no-ops again.
    await withSpan('after', {}, async (span) => expect(span.isRecording()).toBe(false));
  }, 20_000);

  it('honours an abort signal on shutdown', async () => {
    handle = await createTelemetry({
      enabled: true,
      endpoint: 'http://127.0.0.1:9',
      signals: { traces: true, metrics: false, logs: false },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(handle.shutdown(controller.signal)).resolves.toBeUndefined();
  });
});

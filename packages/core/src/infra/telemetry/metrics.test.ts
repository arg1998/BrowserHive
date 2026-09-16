/** @module infra/telemetry/metrics.test — instruments are created lazily once, with catalogue names. */

import { describe, expect, it } from 'bun:test';
import { metrics } from '@opentelemetry/api';
import { createInstruments, METRIC } from './metrics.ts';

describe('createInstruments', () => {
  it('creates each instrument on first access, once', () => {
    const names: string[] = [];
    const meter = metrics.getMeter('test');
    const spy = new Proxy(meter, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function' && String(prop).startsWith('create')) {
          return (name: string, ...rest: unknown[]) => {
            names.push(name);
            return Reflect.apply(value, target, [name, ...rest]);
          };
        }
        return value;
      },
    });
    const instruments = createInstruments(spy);
    expect(names).toEqual([]);
    instruments.toolCalls.add(1, { tool: 'navigate' });
    instruments.toolCalls.add(1, { tool: 'click' });
    instruments.toolCallDuration.record(5, { tool: 'navigate' });
    instruments.sessionsActive.add(1, { state: 'live' });
    instruments.wsBufferedBytes.addCallback(() => undefined);
    instruments.processEventLoopLag.addCallback(() => undefined);
    expect(names).toEqual([
      METRIC.TOOL_CALLS,
      METRIC.TOOL_CALL_DURATION,
      METRIC.SESSIONS_ACTIVE,
      METRIC.WS_BUFFERED_BYTES,
      METRIC.PROCESS_EVENT_LOOP_LAG,
    ]);
  });

  it('every catalogue name starts with browserhive.', () => {
    for (const name of Object.values(METRIC)) expect(name.startsWith('browserhive.')).toBe(true);
  });
});

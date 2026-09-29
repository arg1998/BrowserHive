/** @module infra/telemetry/metrics.test — instruments are created lazily once, with the catalogue's name, unit, description and instrument kind (spec 10 §7). */

import { describe, expect, it } from 'bun:test';
import { metrics } from '@opentelemetry/api';
import { createInstruments, type Instruments, METRIC, METRIC_DEFINITIONS } from './metrics.ts';

type Created = { method: string; name: string; options: { unit?: string; description?: string } };

function spyMeter() {
  const created: Created[] = [];
  const meter = metrics.getMeter('test');
  const spy = new Proxy(meter, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && String(prop).startsWith('create')) {
        return (name: string, options: Created['options'] = {}) => {
          created.push({ method: String(prop), name, options });
          return Reflect.apply(value, target, [name, options]);
        };
      }
      return value;
    },
  });
  return { created, instruments: createInstruments(spy) };
}

/** The meter method each catalogue kind maps to. */
function methodOf(kind: string, observable: boolean): string {
  if (kind === 'histogram') return 'createHistogram';
  if (kind === 'gauge') return 'createObservableGauge';
  if (kind === 'counter') return observable ? 'createObservableCounter' : 'createCounter';
  return observable ? 'createObservableUpDownCounter' : 'createUpDownCounter';
}

describe('createInstruments', () => {
  it('creates each instrument on first access, once', () => {
    const { created, instruments } = spyMeter();
    expect(created).toEqual([]);
    instruments.toolCalls.add(1, { tool: 'navigate' });
    instruments.toolCalls.add(1, { tool: 'click' });
    instruments.toolCallDuration.record(5, { tool: 'navigate' });
    instruments.sessionsActive.add(1, { harness: 'unknown' });
    instruments.wsBufferedBytes.addCallback(() => undefined);
    instruments.processEventLoopLag.addCallback(() => undefined);
    expect(created.map((c) => c.name)).toEqual([
      METRIC.TOOL_CALLS,
      METRIC.TOOL_CALL_DURATION,
      METRIC.SESSIONS_ACTIVE,
      METRIC.WS_BUFFERED_BYTES,
      METRIC.PROCESS_EVENT_LOOP_LAG,
    ]);
  });

  it('gives every instrument the kind, unit and description of its catalogue row', () => {
    const { created, instruments } = spyMeter();
    for (const key of Object.keys(instruments) as (keyof Instruments)[]) void instruments[key];
    const byName = new Map(created.map((c) => [c.name, c]));
    expect(created).toHaveLength(METRIC_DEFINITIONS.length);
    for (const d of METRIC_DEFINITIONS) {
      expect({ name: d.name, ...byName.get(d.name) }).toEqual({
        name: d.name,
        method: methodOf(d.kind, d.observable),
        options: { unit: d.unit, description: d.description },
      });
    }
  });

  it('the catalogue lists every name once, each starting with browserhive.', () => {
    const names = METRIC_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...Object.values(METRIC)].sort());
    for (const name of names) expect(name.startsWith('browserhive.')).toBe(true);
  });
});

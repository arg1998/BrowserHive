/** @module infra/logging/sinks.test — stream/ring sinks and fan-out failure isolation. */

import { describe, expect, it } from 'bun:test';
import type { LogRecord } from './record.ts';
import { createRingBuffer } from './ring-buffer.ts';
import { fanOutSink, type LogSink, MAX_SINK_FAILURES, ringSink, streamSink } from './sinks.ts';

const record: LogRecord = { ts: 1, level: 'info', msg: 'hello', module: 'm' };

describe('streamSink / ringSink', () => {
  it('writes one rendered line per record with a newline', () => {
    const chunks: string[] = [];
    const sink = streamSink('out', { write: (c) => chunks.push(c) }, (r) => r.msg);
    sink.write(record);
    expect(chunks).toEqual(['hello\n']);
  });

  it('pushes into the ring', () => {
    const ring = createRingBuffer(5);
    ringSink(ring).write(record);
    expect(ring.size).toBe(1);
  });
});

describe('fanOutSink', () => {
  it('delivers to every sink and never throws', () => {
    const a: string[] = [];
    const bad: LogSink = {
      name: 'bad',
      write: () => {
        throw new Error('nope');
      },
    };
    const fan = fanOutSink([{ name: 'a', write: (r) => a.push(r.msg) }, bad]);
    expect(() => fan.write(record)).not.toThrow();
    expect(a).toEqual(['hello']);
    expect(fan.failures('bad')).toBe(1);
  });

  it('disables a sink after 10 consecutive failures and reports once', () => {
    const disabled: string[] = [];
    let fail = true;
    const flaky: LogSink = {
      name: 'flaky',
      write: () => {
        if (fail) throw new Error('down');
      },
    };
    const fan = fanOutSink([flaky], {
      onSinkDisabled: (f) => disabled.push(`${f.sink}:${f.consecutiveFailures}`),
    });
    for (let i = 0; i < MAX_SINK_FAILURES - 1; i += 1) fan.write(record);
    expect(fan.names()).toEqual(['flaky']);
    fan.write(record);
    expect(fan.names()).toEqual([]);
    expect(disabled).toEqual([`flaky:${MAX_SINK_FAILURES}`]);
    fail = false;
    fan.write(record);
    expect(disabled).toHaveLength(1);
  });

  it('a success resets the failure count', () => {
    let calls = 0;
    const sink: LogSink = {
      name: 's',
      write: () => {
        calls += 1;
        if (calls % 2 === 1) throw new Error('odd');
      },
    };
    const fan = fanOutSink([sink], { maxConsecutiveFailures: 2 });
    for (let i = 0; i < 20; i += 1) fan.write(record);
    expect(fan.names()).toEqual(['s']);
  });

  it('supports runtime membership and reports flush failures by name', async () => {
    const fan = fanOutSink([]);
    fan.add({ name: 'ok', write: () => undefined, flush: async () => undefined });
    fan.add({
      name: 'broken',
      write: () => undefined,
      flush: () => {
        throw new Error('cannot flush');
      },
    });
    expect(await fan.flushAll()).toEqual(['broken']);
    await expect(fan.flush()).resolves.toBeUndefined();
    fan.remove('broken');
    expect(fan.names()).toEqual(['ok']);
  });
});

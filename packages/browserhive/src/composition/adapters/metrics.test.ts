/** @module composition/adapters/metrics.test — the `harness` metric attribute is folded to the known slug table and never carries model, workspace or meta (spec 10 §7, D-30). */

import { describe, expect, it } from 'bun:test';
import type { DomainEvents, EventBus, Instruments } from '@browserhive/core/runtime';
import { wireMetrics } from './metrics.ts';

type Handler = (event: { name: string; at: number; payload: unknown }) => void;

function fakeBus(): { bus: EventBus<DomainEvents>; emit(name: string, payload: unknown): void } {
  const handlers = new Map<string, Handler[]>();
  const bus = {
    publish: () => undefined,
    subscribeAll: () => () => undefined,
    subscribe: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => undefined;
    },
  } as unknown as EventBus<DomainEvents>;
  return {
    bus,
    emit: (name, payload) => {
      for (const h of handlers.get(name) ?? []) h({ name, at: 0, payload });
    },
  };
}

function fakeInstruments() {
  const adds: { instrument: string; value: number; attrs: Record<string, unknown> }[] = [];
  const counter = (instrument: string) => ({
    add: (value: number, attrs: Record<string, unknown> = {}) =>
      adds.push({ instrument, value, attrs }),
    record: (value: number, attrs: Record<string, unknown> = {}) =>
      adds.push({ instrument, value, attrs }),
    addCallback: () => undefined,
    removeCallback: () => undefined,
  });
  const instruments = new Proxy(
    {},
    { get: (_target, name) => counter(String(name)) },
  ) as unknown as Instruments;
  return { instruments, adds };
}

describe('wireMetrics: harness attribute', () => {
  it('folds unknown slugs into other and keeps known ones', () => {
    const { bus, emit } = fakeBus();
    const { instruments, adds } = fakeInstruments();
    const stop = wireMetrics(instruments, bus, {
      queue: { depth: 0 },
      analytics: { databaseSize: async () => 0 },
    });
    const call = (harness: string) =>
      emit('tool.called', {
        observation: { tool: 'navigate', ok: true, errorCode: null, durationMs: 5, harness },
      });
    call('claude-code');
    call('nightly-scraper');
    emit('session.opened', { session: { session_id: 's-1', created_at: 1, harness: 'my-bot' } });
    emit('session.closed', { session_id: 's-1', closed_at: 2 });
    stop();
    const calls = adds.filter((a) => a.instrument === 'toolCalls').map((a) => a.attrs);
    expect(calls).toEqual([
      { tool: 'navigate', ok: true, harness: 'claude-code' },
      { tool: 'navigate', ok: true, harness: 'other' },
    ]);
    // Never on the duration histogram.
    for (const a of adds.filter((x) => x.instrument === 'toolCallDuration')) {
      expect(a.attrs).toEqual({ tool: 'navigate' });
    }
    expect(
      adds.filter((a) => a.instrument === 'sessionsActive').map((a) => [a.value, a.attrs]),
    ).toEqual([
      [1, { harness: 'other' }],
      [-1, { harness: 'other' }],
    ]);
  });
});

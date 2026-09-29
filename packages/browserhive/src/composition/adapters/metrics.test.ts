/** @module composition/adapters/metrics.test — what each bus event and observable source records (spec 10 §7): the `harness` attribute folded to the known slug table and never model, workspace or meta (D-30); launch duration once per session; lifetime by closed reason; operator requests by kind and the attention wait by status; pruned rows by table; the write queue, hub, browser-memory and event-loop callbacks; unwiring. */

import { describe, expect, it } from 'bun:test';
import type { DomainEvents, EventBus, Instruments } from '@browserhive/core/runtime';
import { type MetricSources, wireMetrics } from './metrics.ts';

type Handler = (event: { name: string; at: number; payload: unknown }) => void;

function fakeBus(): { bus: EventBus<DomainEvents>; emit(name: string, payload: unknown): void } {
  const handlers = new Map<string, Handler[]>();
  const bus = {
    publish: () => undefined,
    subscribeAll: () => () => undefined,
    subscribe: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((h) => h !== handler),
        );
      };
    },
  } as unknown as EventBus<DomainEvents>;
  return {
    bus,
    emit: (name, payload) => {
      for (const h of handlers.get(name) ?? []) h({ name, at: 0, payload });
    },
  };
}

type Observed = { value: number; attrs: Record<string, unknown> };
type Callback = (result: { observe(value: number, attrs?: Record<string, unknown>): void }) => void;

function fakeInstruments() {
  const adds: { instrument: string; value: number; attrs: Record<string, unknown> }[] = [];
  const callbacks = new Map<string, Callback[]>();
  const cache = new Map<string, unknown>();
  const instrument = (name: string) => ({
    add: (value: number, attrs: Record<string, unknown> = {}) =>
      adds.push({ instrument: name, value, attrs }),
    record: (value: number, attrs: Record<string, unknown> = {}) =>
      adds.push({ instrument: name, value, attrs }),
    addCallback: (cb: Callback) => callbacks.set(name, [...(callbacks.get(name) ?? []), cb]),
    removeCallback: (cb: Callback) =>
      callbacks.set(
        name,
        (callbacks.get(name) ?? []).filter((c) => c !== cb),
      ),
  });
  const instruments = new Proxy(
    {},
    {
      get: (_target, name) => {
        const key = String(name);
        if (!cache.has(key)) cache.set(key, instrument(key));
        return cache.get(key);
      },
    },
  ) as unknown as Instruments;
  const collect = (name: string): Observed[] => {
    const out: Observed[] = [];
    for (const cb of callbacks.get(name) ?? []) {
      cb({ observe: (value, attrs = {}) => out.push({ value, attrs }) });
    }
    return out;
  };
  const of = (name: string) =>
    adds.filter((a) => a.instrument === name).map((a) => [a.value, a.attrs]);
  return { instruments, adds, callbacks, collect, of };
}

function sources(overrides: Partial<MetricSources> = {}): MetricSources {
  return {
    queue: { depth: 0, droppedWritesByTable: new Map() },
    analytics: { databaseSize: async () => 0 },
    eventLoop: () => null,
    ...overrides,
  };
}

function summary(id: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: id,
    created_at: 1_000,
    harness: 'claude-code',
    channel: 'chromium',
    stealth: false,
    ...extra,
  };
}

function request(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return {
    request_id: id,
    kind,
    status: 'pending',
    created_at: 1_000,
    resolved_at: null,
    waited_ms: null,
    ...extra,
  };
}

describe('wireMetrics: harness attribute', () => {
  it('folds unknown slugs into other and keeps known ones', () => {
    const { bus, emit } = fakeBus();
    const { instruments, adds } = fakeInstruments();
    const stop = wireMetrics(instruments, bus, sources());
    const call = (harness: string) =>
      emit('tool.called', {
        observation: { tool: 'navigate', ok: true, errorCode: null, durationMs: 5, harness },
      });
    call('claude-code');
    call('nightly-scraper');
    emit('session.opened', { session: { session_id: 's-1', created_at: 1, harness: 'my-bot' } });
    emit('session.closed', { session_id: 's-1', closed_at: 2, reason: 'user' });
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

  it('adds error_code only on failed calls', () => {
    const { bus, emit } = fakeBus();
    const { instruments, of } = fakeInstruments();
    wireMetrics(instruments, bus, sources());
    emit('tool.called', {
      observation: {
        tool: 'click',
        ok: false,
        errorCode: 'ELEMENT_NOT_FOUND',
        durationMs: 9,
        harness: 'unknown',
      },
    });
    expect(of('toolCalls')).toEqual([
      [1, { tool: 'click', ok: false, harness: 'unknown', error_code: 'ELEMENT_NOT_FOUND' }],
    ]);
  });
});

describe('wireMetrics: sessions', () => {
  it('records the launch duration once per session, by channel and stealth', () => {
    const { bus, emit } = fakeBus();
    const { instruments, of } = fakeInstruments();
    wireMetrics(instruments, bus, sources());
    emit('session.opened', { session: summary('s-1', { channel: 'chrome', stealth: true }) });
    // Reserved, then launched, then later patches that repeat `launchMs`.
    emit('session.updated', { session: summary('s-1'), patch: { launchMs: null } });
    emit('session.updated', {
      session: summary('s-1', { channel: 'chrome', stealth: true }),
      patch: { launchMs: 850 },
    });
    emit('session.updated', { session: summary('s-1'), patch: { launchMs: 850 } });
    // A session this process never saw open (no baseline) is not a launch.
    emit('session.updated', { session: summary('s-9'), patch: { launchMs: 5 } });
    expect(of('sessionLaunchDuration')).toEqual([[850, { channel: 'chrome', stealth: true }]]);
  });

  it('records the lifetime by closed reason', () => {
    const { bus, emit } = fakeBus();
    const { instruments, of } = fakeInstruments();
    wireMetrics(instruments, bus, sources());
    emit('session.opened', { session: summary('s-1') });
    emit('session.closed', { session_id: 's-1', closed_at: 61_000, reason: 'lease_expired' });
    expect(of('sessionLifetime')).toEqual([[60_000, { closed_reason: 'lease_expired' }]]);
  });
});

describe('wireMetrics: operator requests', () => {
  it('counts open requests by kind and records the attention wait by status', () => {
    const { bus, emit } = fakeBus();
    const { instruments, of } = fakeInstruments();
    wireMetrics(instruments, bus, sources());
    emit('attention.created', { request: request('a-1', 'attention') });
    emit('vault.confirm.created', { request: request('v-1', 'vault_confirm') });
    emit('attention.resolved', {
      request: request('a-1', 'attention', {
        status: 'timeout',
        resolved_at: 4_000,
        waited_ms: 3_000,
      }),
    });
    emit('vault.confirm.resolved', { request: request('v-1', 'vault_confirm') });
    // Settled by the startup reconcile, opened by a previous run: no negative count.
    emit('attention.resolved', {
      request: request('a-0', 'attention', { status: 'rejected', resolved_at: 1_500 }),
    });
    expect(of('attentionOpen')).toEqual([
      [1, { kind: 'attention' }],
      [1, { kind: 'vault_confirm' }],
      [-1, { kind: 'attention' }],
      [-1, { kind: 'vault_confirm' }],
    ]);
    expect(of('attentionWait')).toEqual([
      [3_000, { status: 'timeout' }],
      [500, { status: 'rejected' }],
    ]);
  });
});

describe('wireMetrics: retention', () => {
  it('adds pruned rows per table, skipping tables that lost none', () => {
    const { bus, emit } = fakeBus();
    const { instruments, of } = fakeInstruments();
    wireMetrics(instruments, bus, sources());
    emit('retention.completed', {
      pruned_rows: 7,
      prunedByTable: { tool_calls: 5, pages: 2, logs: 0 },
    });
    expect(of('retentionPrunedRows')).toEqual([
      [5, { table: 'tool_calls' }],
      [2, { table: 'pages' }],
    ]);
  });
});

describe('wireMetrics: observable instruments', () => {
  it('reads the queue, the hub, the browser sampler, the event loop and this process', async () => {
    const { bus } = fakeBus();
    const { instruments, collect } = fakeInstruments();
    let hubOpen = false;
    const sockets = Array.from({ length: 60 }, (_, i) => ({
      connectionId: `c-${i}`,
      bufferedBytes: i,
    }));
    wireMetrics(
      instruments,
      bus,
      sources({
        queue: { depth: 3, droppedWritesByTable: new Map([['tool_calls', 2]]) },
        analytics: { databaseSize: async () => 4096 },
        realtime: () =>
          hubOpen
            ? { sockets: () => sockets, droppedFrames: () => ({ screencast: 4, logs: 1, feed: 0 }) }
            : undefined,
        browserMemory: () => new Map([['s-1', 123_456]]),
        eventLoop: () => ({ takeP99Ms: () => 12.5, stop: () => undefined }),
      }),
    );
    await Promise.resolve();
    expect(collect('dbWriteQueueDepth')).toEqual([{ value: 3, attrs: {} }]);
    expect(collect('dbDroppedWrites')).toEqual([{ value: 2, attrs: { table: 'tool_calls' } }]);
    expect(collect('dbSizeBytes')).toEqual([{ value: 4096, attrs: {} }]);
    expect(collect('browserRssBytes')).toEqual([{ value: 123_456, attrs: { session_id: 's-1' } }]);
    expect(collect('processEventLoopLag')).toEqual([{ value: 12.5, attrs: {} }]);
    expect(collect('processRssBytes')[0]?.value).toBeGreaterThan(0);
    expect(collect('processHeapBytes')[0]?.value).toBeGreaterThan(0);
    // Before the listeners open (and under stdio) the hub instruments have no data points.
    expect(collect('wsConnections')).toEqual([]);
    hubOpen = true;
    expect(collect('wsConnections')).toEqual([{ value: 60, attrs: {} }]);
    const buffered = collect('wsBufferedBytes');
    expect(buffered).toHaveLength(50);
    expect(buffered[0]).toEqual({ value: 59, attrs: { connection_id: 'c-59' } });
    expect(collect('wsFramesDropped')).toEqual([
      { value: 4, attrs: { channel: 'screencast' } },
      { value: 1, attrs: { channel: 'logs' } },
      { value: 0, attrs: { channel: 'feed' } },
    ]);
  });

  it('unwiring removes every callback and subscription and stops the event-loop monitor', () => {
    const { bus, emit } = fakeBus();
    const { instruments, callbacks, adds } = fakeInstruments();
    let stopped = 0;
    const unwire = wireMetrics(
      instruments,
      bus,
      sources({ eventLoop: () => ({ takeP99Ms: () => 1, stop: () => void stopped++ }) }),
    );
    expect([...callbacks.values()].flat().length).toBe(10);
    unwire();
    expect([...callbacks.values()].flat().length).toBe(0);
    expect(stopped).toBe(1);
    emit('attention.created', { request: request('a-1', 'attention') });
    expect(adds).toEqual([]);
  });
});

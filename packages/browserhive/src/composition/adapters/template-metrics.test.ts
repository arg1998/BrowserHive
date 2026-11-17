/** @module composition/adapters/template-metrics.test — the template instruments (spec 13 §11.7): hosts per state at each export (0 included, `stopped` left out, nothing with templates off), one probe count per `template.probe`, one re-login count per finished re-login (`timed_out` → `timeout`, `cancelled` and repeats not counted), through `wireMetrics`. */

import { describe, expect, it } from 'bun:test';
import type { DomainEvents, EventBus, Instruments } from '@browserhive/core/runtime';
import { wireMetrics } from './metrics.ts';
import { hostsByState, reloginOutcomes, TEMPLATE_HOST_STATES } from './template-metrics.ts';

type Handler = (event: { name: string; at: number; payload: unknown }) => void;
type Callback = (result: { observe(value: number, attrs?: Record<string, unknown>): void }) => void;

/** A bus, instruments and sources as `wireMetrics` uses them, recording what is written. */
function world(templateHosts?: () => Iterable<string>) {
  const handlers = new Map<string, Handler[]>();
  const bus = {
    publish: () => undefined,
    subscribeAll: () => () => undefined,
    subscribe: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () =>
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((h) => h !== handler),
        );
    },
  } as unknown as EventBus<DomainEvents>;
  const adds: { instrument: string; attrs: Record<string, unknown> }[] = [];
  const callbacks = new Map<string, Callback[]>();
  const cache = new Map<string, unknown>();
  const instruments = new Proxy(
    {},
    {
      get: (_t, name) => {
        const key = String(name);
        if (!cache.has(key)) {
          cache.set(key, {
            add: (_v: number, attrs: Record<string, unknown> = {}) =>
              adds.push({ instrument: key, attrs }),
            record: () => undefined,
            addCallback: (cb: Callback) => callbacks.set(key, [...(callbacks.get(key) ?? []), cb]),
            removeCallback: (cb: Callback) =>
              callbacks.set(
                key,
                (callbacks.get(key) ?? []).filter((c) => c !== cb),
              ),
          });
        }
        return cache.get(key);
      },
    },
  ) as unknown as Instruments;
  const unwire = wireMetrics(instruments, bus, {
    queue: { depth: 0, droppedWritesByTable: new Map() },
    analytics: { databaseSize: async () => 0 },
    eventLoop: () => null,
    ...(templateHosts !== undefined && { templateHosts }),
  });
  return {
    emit: (name: string, payload: unknown) => {
      for (const h of handlers.get(name) ?? []) h({ name, at: 0, payload });
    },
    of: (name: string) => adds.filter((a) => a.instrument === name).map((a) => a.attrs),
    collect: (name: string) => {
      const out: [number, Record<string, unknown>][] = [];
      for (const cb of callbacks.get(name) ?? [])
        cb({ observe: (value, attrs = {}) => out.push([value, attrs]) });
      return out;
    },
    unwire,
  };
}

function relogin(state: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'template.relogin',
    template_id: 'tp-aaaaaaaaaa',
    relogin: {
      site_id: 'site-a.test',
      method: 'window',
      state,
      session_id: null,
      requested_by: 'admin',
      requested_at: 1_000,
      deadline_at: null,
      finished_at: null,
      agents_paused: false,
      sign_in_via: 'window',
      confirm_required: false,
      version: null,
      unlisted_domains: [],
      error: null,
      ...extra,
    },
  } as DomainEvents['template.relogin'];
}

describe('browserhive.template.hosts', () => {
  it('reports every state at each export, 0 included, and leaves stopped hosts out', () => {
    const states = ['running', 'running', 'stopped', 'failed', 'weird'];
    const w = world(() => states);
    expect(w.collect('templateHosts')).toEqual([
      [0, { state: 'starting' }],
      [2, { state: 'running' }],
      [0, { state: 'draining' }],
      [0, { state: 'crashed' }],
      [1, { state: 'failed' }],
    ]);
    states.splice(0, 2);
    expect(w.collect('templateHosts').find(([, a]) => a['state'] === 'running')?.[0]).toBe(0);
    expect([...hostsByState([]).keys()]).toEqual([...TEMPLATE_HOST_STATES]);
  });

  it('reports nothing with templates off, and stops after unwiring', () => {
    expect(world().collect('templateHosts')).toEqual([]);
    const w = world(() => ['running']);
    w.unwire();
    expect(w.collect('templateHosts')).toEqual([]);
  });
});

describe('browserhive.template.probes', () => {
  it('counts one per template.probe with outcome and trigger', () => {
    const w = world();
    const probe = (outcome: string, trigger: string) => ({
      type: 'template.probe',
      template_id: 'tp-aaaaaaaaaa',
      probe: {
        seq: 1,
        site_id: 's',
        outcome,
        reason: 'r',
        trigger,
        final_url: null,
        duration_ms: 1,
        at: 1,
      },
    });
    w.emit('template.probe', probe('signed_in', 'schedule'));
    w.emit('template.probe', probe('signed_out', 'prelaunch'));
    expect(w.of('templateProbes')).toEqual([
      { outcome: 'signed_in', trigger: 'schedule' },
      { outcome: 'signed_out', trigger: 'prelaunch' },
    ]);
  });
});

describe('browserhive.template.relogins', () => {
  it('counts a re-login once when it finishes; timed_out is timeout; cancelled and repeats are not counted', () => {
    const w = world();
    for (const state of ['queued', 'open', 'filling']) w.emit('template.relogin', relogin(state));
    expect(w.of('templateRelogins')).toEqual([]);
    w.emit('template.relogin', relogin('signed_in'));
    w.emit('template.relogin', relogin('signed_in'));
    w.emit('template.relogin', relogin('timed_out', { requested_at: 2_000 }));
    w.emit('template.relogin', relogin('failed', { requested_at: 3_000, method: 'vault' }));
    w.emit('template.relogin', relogin('failed', { requested_at: 3_000, site_id: 'site-b.test' }));
    w.emit('template.relogin', relogin('cancelled', { requested_at: 4_000 }));
    expect(w.of('templateRelogins')).toEqual([
      { method: 'window', outcome: 'signed_in' },
      { method: 'window', outcome: 'timeout' },
      { method: 'vault', outcome: 'failed' },
      { method: 'window', outcome: 'failed' },
    ]);
  });

  it('forgets the oldest re-logins past its bound', () => {
    const counted = reloginOutcomes();
    expect(counted(relogin('signed_in', { requested_at: 0 }))).not.toBeNull();
    for (let i = 1; i <= 1_024; i++) counted(relogin('signed_in', { requested_at: i }));
    // The first one was forgotten (a repeat this late is counted again); the newest is still known.
    expect(counted(relogin('signed_in', { requested_at: 0 }))).not.toBeNull();
    expect(counted(relogin('signed_in', { requested_at: 1_024 }))).toBeNull();
  });
});

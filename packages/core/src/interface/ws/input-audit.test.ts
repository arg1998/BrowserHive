/** @module interface/ws/input-audit.test — accepted takeover input becomes one `operator_actions` row per session, principal and second; counts only. */
import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import type { NewOperatorAction } from '../../ports/persistence/records.ts';
import { OperatorInputAudit } from './input-audit.ts';

function setup(options: { failWrites?: boolean } = {}) {
  let now = 1_000;
  let seq = 0;
  const rows: NewOperatorAction[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const logger = new CollectingLogger();
  const audit = new OperatorInputAudit({
    actions: {
      append: async (action) => {
        if (options.failWrites === true) throw new Error('database is locked');
        rows.push(action);
        return rows.length;
      },
    },
    eventId: () => `e-${++seq}`,
    now: () => now,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    logger,
  });
  const fire = async () => {
    for (const t of timers.filter((t) => !t.cancelled)) {
      t.cancelled = true;
      t.fn();
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    audit,
    rows,
    timers,
    logger,
    fire,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const WS = { principalId: 'admin', via: 'ws' } as const;

describe('OperatorInputAudit (spec 03 §6.3)', () => {
  it('coalesces a burst into one row stamped with its first input', async () => {
    const t = setup();
    t.audit.record('shop-00000001', WS, 'key');
    t.advance(200);
    t.audit.record('shop-00000001', WS, 'key');
    t.audit.record('shop-00000001', { principalId: 'admin', via: 'rest' }, 'mouse');
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]?.ms).toBe(1_000);
    expect(t.rows).toEqual([]);
    await t.fire();
    expect(t.rows).toEqual([
      {
        eventId: 'e-1',
        principalId: 'admin',
        action: 'input',
        resourceKind: 'session',
        resourceId: 'shop-00000001',
        details: { inputs: 3, mouse: 1, key: 2, touch: 0, via: ['rest', 'ws'], window_ms: 1_000 },
        occurredAt: 1_000,
      },
    ]);
  });

  it('keeps sessions and principals apart, and opens a new window after a flush', async () => {
    const t = setup();
    t.audit.record('shop-00000001', WS, 'key');
    t.audit.record('shop-00000002', WS, 'key');
    t.audit.record('shop-00000001', { principalId: 'second-op', via: 'ws' }, 'touch');
    await t.fire();
    expect(t.rows.map((r) => [r.resourceId, r.principalId])).toEqual([
      ['shop-00000001', 'admin'],
      ['shop-00000002', 'admin'],
      ['shop-00000001', 'second-op'],
    ]);
    t.audit.record('shop-00000001', WS, 'mouse');
    await t.fire();
    expect(t.rows).toHaveLength(4);
  });

  it('stores counts only: no key, text or coordinates can reach the row', async () => {
    const t = setup();
    t.audit.record('shop-00000001', WS, 'key');
    await t.fire();
    expect(Object.keys(t.rows[0]?.details ?? {}).sort()).toEqual([
      'inputs',
      'key',
      'mouse',
      'touch',
      'via',
      'window_ms',
    ]);
  });

  it('flushAll writes the open windows on shutdown and cancels their timers', async () => {
    const t = setup();
    t.audit.record('shop-00000001', WS, 'mouse');
    await t.audit.flushAll();
    expect(t.rows).toHaveLength(1);
    expect(t.timers.every((timer) => timer.cancelled)).toBe(true);
    await t.fire();
    expect(t.rows).toHaveLength(1);
  });

  it('a failed write is logged, never thrown', async () => {
    const t = setup({ failWrites: true });
    t.audit.record('shop-00000001', WS, 'key');
    await t.audit.flushAll();
    expect(t.logger.records.some((r) => r.msg === 'input audit write failed')).toBe(true);
  });
});

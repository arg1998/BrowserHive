/** @module app/site-packs/strategy-state.test — the persisted strategy state (D53) over an in-memory repository and a fake clock: write-through timing (budgets and turns at once, dwell times within the flush interval, everything on stop), the restore (expired state comes back as nothing and its row goes, a corrupt row is discarded with a warning, an unreadable table starts empty, a newer binary's strategy is left alone, clock skew is clamped), and a deleted template's state. */

import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { InMemoryStrategyStateRepository } from '../../../test/helpers/in-memory-strategy-state-repo.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import type { StrategyStateRecord } from '../../ports/persistence/strategy-state.ts';
import type { DomainEvents } from '../events/catalog.ts';
import {
  DWELL_RESTORE_MAX_MS,
  LAUNCH_TURN_MAX_AHEAD_MS,
  restoreState,
  STRATEGY_STATE_FLUSH_MS,
  StrategyState,
} from './strategy-state.ts';

const T0 = 1_700_000_000_000;

/** Lets queued microtasks and the repository's promises run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function world(repo = new InMemoryStrategyStateRepository(), clock = new FakeClock(T0)) {
  const bus = new RecordingEventBus<DomainEvents>();
  const logger = createCollectingLogger();
  const timers: { fn: () => void; ms: number }[] = [];
  const state = new StrategyState({
    repo,
    clock,
    logger,
    bus,
    schedule: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  });
  const fire = () => {
    for (const t of timers.splice(0)) t.fn();
  };
  return { repo, clock, bus, logger, state, timers, fire };
}

function row(overrides: Partial<StrategyStateRecord>): StrategyStateRecord {
  return {
    templateId: 'tp-a',
    strategy: 'launch-spacing',
    packId: '',
    scopeKey: '',
    stateJson: JSON.stringify({ next_at: T0 + 10_000 }),
    updatedAt: T0,
    ...overrides,
  };
}

describe('StrategyState writes', () => {
  it('writes budgets and turns at once, dwell times within the flush interval', async () => {
    const { repo, state, timers, fire } = world();
    state.set('launch-spacing', { templateId: 'tp-a' }, { nextAt: T0 + 5_000 }, 'now');
    await settle();
    expect([...repo.rows.values()]).toEqual([
      row({ stateJson: '{"next_at":1700000005000}', updatedAt: T0 }),
    ]);

    state.set('human-dwell', { templateId: 'tp-a', packId: 'site-a.test' }, { lastAt: T0 }, 'soon');
    state.set(
      'human-dwell',
      { templateId: 'tp-a', packId: 'site-a.test' },
      { lastAt: T0 + 1 },
      'soon',
    );
    await settle();
    expect(repo.rows.size).toBe(1);
    // One timer for any number of changes (no write per keystroke).
    expect(timers.map((t) => t.ms)).toEqual([STRATEGY_STATE_FLUSH_MS]);
    fire();
    await settle();
    const dwell = [...repo.rows.values()].find((r) => r.strategy === 'human-dwell');
    expect(dwell).toMatchObject({ packId: 'site-a.test', stateJson: '{"last_at":1700000000001}' });
  });

  it('stop writes what is pending and cancels the timer', async () => {
    const { repo, state, timers } = world();
    state.set('human-dwell', { templateId: 'tp-a', packId: 'p' }, { lastAt: T0 }, 'soon');
    await state.stop();
    expect(timers).toEqual([]);
    expect(repo.rows.size).toBe(1);
  });

  it('delete removes the row with the next write', async () => {
    const { repo, state } = world();
    state.set('launch-spacing', { templateId: 'tp-a' }, { nextAt: T0 + 5_000 }, 'now');
    await settle();
    state.delete('launch-spacing', { templateId: 'tp-a' });
    expect(state.get('launch-spacing', { templateId: 'tp-a' })).toBeUndefined();
    await state.flush();
    expect(repo.rows.size).toBe(0);
  });

  it('a failed write is logged and never throws', async () => {
    const { repo, state, logger } = world();
    repo.failPuts = true;
    state.set('launch-spacing', { templateId: 'tp-a' }, { nextAt: T0 + 5_000 }, 'now');
    await state.flush();
    expect(logger.records.some((r) => r.msg === 'strategy state not saved')).toBe(true);
  });

  it("a deleted template's state goes, pending writes included", async () => {
    const { repo, state, bus } = world();
    state.set('launch-spacing', { templateId: 'tp-a' }, { nextAt: T0 + 5_000 }, 'soon');
    state.set('launch-spacing', { templateId: 'tp-b' }, { nextAt: T0 + 5_000 }, 'soon');
    bus.publish('template.removed', {
      template_id: 'tp-a',
    } as unknown as DomainEvents['template.removed']);
    await state.flush();
    expect(state.get('launch-spacing', { templateId: 'tp-a' })).toBeUndefined();
    expect([...repo.rows.values()].map((r) => r.templateId)).toEqual(['tp-b']);
  });
});

describe('StrategyState restore', () => {
  it('restores live state; expired state comes back as nothing and its row goes', async () => {
    const repo = new InMemoryStrategyStateRepository();
    const first = world(repo);
    first.state.set('launch-spacing', { templateId: 'tp-a' }, { nextAt: T0 + 30_000 }, 'now');
    first.state.set('launch-spacing', { templateId: 'tp-b' }, { nextAt: T0 + 1_000 }, 'now');
    await first.state.stop();

    const clock = new FakeClock(T0 + 5_000);
    const second = world(repo, clock);
    await second.state.restore();
    expect(second.state.get('launch-spacing', { templateId: 'tp-a' })).toEqual({
      nextAt: T0 + 30_000,
    });
    expect(second.state.restored('launch-spacing', { templateId: 'tp-a' })).toEqual({
      nextAt: T0 + 30_000,
    });
    expect(second.state.get('launch-spacing', { templateId: 'tp-b' })).toBeUndefined();
    second.fire();
    await settle();
    expect([...repo.rows.values()].map((r) => r.templateId)).toEqual(['tp-a']);
  });

  it('a corrupt row is discarded with a warning; the others restore', async () => {
    const repo = new InMemoryStrategyStateRepository();
    await repo.put(row({ templateId: 'tp-bad', stateJson: '{not json' }));
    await repo.put(row({ templateId: 'tp-shape', stateJson: '{"next_at":"soon"}' }));
    await repo.put(row({ templateId: 'tp-ok' }));
    const { state, logger, fire } = world(repo);
    await state.restore();
    expect(state.get('launch-spacing', { templateId: 'tp-ok' })).toEqual({ nextAt: T0 + 10_000 });
    expect(state.get('launch-spacing', { templateId: 'tp-bad' })).toBeUndefined();
    const warned = logger.records.filter((r) => r.msg === 'strategy row discarded');
    expect(warned.map((r) => r.fields?.['templateId'])).toEqual(['tp-bad', 'tp-shape']);
    fire();
    await settle();
    expect([...repo.rows.values()].map((r) => r.templateId)).toEqual(['tp-ok']);
  });

  it('an unreadable table starts empty without throwing', async () => {
    const repo = new InMemoryStrategyStateRepository();
    repo.list = async () => Promise.reject(new Error('no such table'));
    const { state, logger } = world(repo);
    await state.restore();
    expect(logger.records.some((r) => r.msg === 'strategy state unreadable')).toBe(true);
  });

  it("leaves a newer binary's strategy rows alone", async () => {
    const repo = new InMemoryStrategyStateRepository();
    await repo.put(row({ strategy: 'future-strategy', stateJson: '{"x":1}' }));
    const { state, fire } = world(repo);
    await state.restore();
    fire();
    await state.flush();
    expect(repo.rows.size).toBe(1);
  });
});

describe('restoreState', () => {
  it('pace-writes: refilled from the saved time; a full bucket has expired', () => {
    const json = JSON.stringify({ tokens: 0, at: T0, capacity: 10, period_ms: 3_600_000 });
    // 30 min later: 5 of 10 tokens are back.
    expect(restoreState('pace-writes', json, T0 + 1_800_000)).toEqual({
      tokens: 5,
      at: T0 + 1_800_000,
      capacity: 10,
      periodMs: 3_600_000,
    });
    expect(restoreState('pace-writes', json, T0 + 3_600_000)).toBe('expired');
    expect(restoreState('pace-writes', '{"tokens":1,"at":1,"capacity":0,"period_ms":1}', T0)).toBe(
      'corrupt',
    );
  });

  it('clamps times ahead of the clock (the clock went back)', () => {
    const turn = JSON.stringify({ next_at: T0 + 10 * LAUNCH_TURN_MAX_AHEAD_MS });
    expect(restoreState('launch-spacing', turn, T0)).toEqual({
      nextAt: T0 + LAUNCH_TURN_MAX_AHEAD_MS,
    });
    expect(restoreState('human-dwell', JSON.stringify({ last_at: T0 + 60_000 }), T0)).toEqual({
      lastAt: T0,
    });
    const bucket = JSON.stringify({ tokens: 0, at: T0 + 60_000, capacity: 1, period_ms: 60_000 });
    expect(restoreState('pace-writes', bucket, T0)).toMatchObject({ tokens: 0, at: T0 });
  });

  it('human-dwell: a last action older than the longest dwell has expired', () => {
    const json = JSON.stringify({ last_at: T0 });
    expect(restoreState('human-dwell', json, T0 + DWELL_RESTORE_MAX_MS)).toEqual({ lastAt: T0 });
    expect(restoreState('human-dwell', json, T0 + DWELL_RESTORE_MAX_MS + 1)).toBe('expired');
    expect(restoreState('human-dwell', 'null', T0)).toBe('corrupt');
  });
});

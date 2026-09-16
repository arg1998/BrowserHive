/** @module infra/browsers/humanize/cursor.test — cursor tracker, moveTo/clickBox/scrollBy against a fake mouse. */

import { describe, expect, it } from 'bun:test';
import type { Vector } from './bezier.ts';
import { type CursorPage, CursorTracker, clickBox, moveTo, scrollBy } from './cursor.ts';
import { seededRng } from './rng.ts';

/** Records every mouse call so the tests can assert on the emitted event stream. */
function fakePage(
  viewport: { width: number; height: number } | null = { width: 800, height: 600 },
) {
  const moves: Vector[] = [];
  const events: string[] = [];
  const wheels: [number, number][] = [];
  const page: CursorPage = {
    viewportSize: () => viewport,
    mouse: {
      async move(x, y) {
        moves.push({ x, y });
        events.push('move');
      },
      async down(options) {
        events.push(`down:${options?.button ?? 'left'}:${options?.clickCount ?? 0}`);
      },
      async up(options) {
        events.push(`up:${options?.button ?? 'left'}:${options?.clickCount ?? 0}`);
      },
      async wheel(dx, dy) {
        wheels.push([dx, dy]);
        events.push('wheel');
      },
    },
  };
  return { page, moves, events, wheels };
}

const noSleep = async (): Promise<void> => undefined;

describe('CursorTracker', () => {
  it('seeds a plausible entry point instead of the viewport origin', () => {
    // A pointer that begins every session at exactly {0,0} is a constant, and constants correlate
    // sessions to each other.
    const tracker = new CursorTracker();
    const viewport = { width: 800, height: 600 };
    let origins = 0;
    for (let i = 0; i < 100; i++) {
      const key = {};
      const seeded = tracker.get(key, viewport, seededRng(`seed-${i}`));
      expect(seeded.x).toBeGreaterThanOrEqual(0);
      expect(seeded.x).toBeLessThanOrEqual(viewport.width);
      expect(seeded.y).toBeGreaterThanOrEqual(0);
      expect(seeded.y).toBeLessThanOrEqual(viewport.height);
      if (seeded.x === 0 && seeded.y === 0) origins++;
    }
    expect(origins).toBe(0);
  });

  it('is stable per page once seeded', () => {
    const tracker = new CursorTracker();
    const key = {};
    const first = tracker.get(key, { width: 800, height: 600 }, seededRng('a'));
    const second = tracker.get(key, { width: 800, height: 600 }, seededRng('different'));
    expect(second).toEqual(first);
  });

  it('keeps positions separate per page', () => {
    // Playwright's mouse state is per-Page: a shared position would generate a path starting where
    // the *other* tab's pointer was — a movement the driver never performs.
    const tracker = new CursorTracker();
    const a = {};
    const b = {};
    tracker.set(a, { x: 10, y: 10 });
    tracker.set(b, { x: 500, y: 400 });
    expect(tracker.get(a, { width: 800, height: 600 }, seededRng('x'))).toEqual({ x: 10, y: 10 });
    expect(tracker.get(b, { width: 800, height: 600 }, seededRng('x'))).toEqual({ x: 500, y: 400 });
  });

  it('adopts an operator takeover coordinate exactly', () => {
    const tracker = new CursorTracker();
    const key = {};
    tracker.set(key, { x: 1, y: 1 });
    tracker.observeExternalMove(key, 321, 123);
    expect(tracker.get(key, { width: 800, height: 600 }, seededRng('x'))).toEqual({
      x: 321,
      y: 123,
    });
  });

  it('re-seeds after invalidation', () => {
    const tracker = new CursorTracker();
    const key = {};
    tracker.set(key, { x: 42, y: 42 });
    tracker.invalidate(key);
    expect(tracker.get(key, { width: 800, height: 600 }, seededRng('x'))).not.toEqual({
      x: 42,
      y: 42,
    });
  });
});

describe('moveTo', () => {
  it('ends on the target and records the final position', async () => {
    const { page, moves } = fakePage();
    const tracker = new CursorTracker();
    await moveTo(page, tracker, { x: 400, y: 300 }, { rng: seededRng('move'), sleep: noSleep });
    const last = moves[moves.length - 1];
    expect(last?.x).toBeCloseTo(400, 6);
    expect(last?.y).toBeCloseTo(300, 6);
    expect(tracker.get(page, { width: 800, height: 600 }, seededRng('x'))).toEqual(
      last ?? { x: -1, y: -1 },
    );
  });

  it('emits many intermediate points and a deterministic schedule for a seed', async () => {
    const run = async (): Promise<{ moves: Vector[]; slept: number[] }> => {
      const { page, moves } = fakePage();
      const slept: number[] = [];
      await moveTo(
        page,
        new CursorTracker(),
        { x: 700, y: 500 },
        {
          rng: seededRng('m'),
          sleep: async (ms) => {
            slept.push(ms);
          },
        },
      );
      return { moves, slept };
    };
    const a = await run();
    const b = await run();
    expect(a.moves.length).toBeGreaterThan(5);
    expect(a.slept.length).toBeGreaterThan(0);
    expect(a.slept).toEqual(b.slept);
    expect(a.moves).toEqual(b.moves);
  });

  it('clamps the target inside the viewport', async () => {
    // Chromium silently drops a move outside the viewport, which would desync our mirror from the
    // real pointer for every subsequent path.
    const { page, moves } = fakePage({ width: 800, height: 600 });
    await moveTo(
      page,
      new CursorTracker(),
      { x: 5_000, y: -20 },
      { rng: seededRng('c'), sleep: noSleep },
    );
    for (const move of moves) {
      expect(move.x).toBeGreaterThanOrEqual(0);
      expect(move.x).toBeLessThanOrEqual(799);
      expect(move.y).toBeGreaterThanOrEqual(0);
      expect(move.y).toBeLessThanOrEqual(599);
    }
  });

  it('records the last successful position when a move throws mid-path', async () => {
    // A failure must not leave the mirror claiming the pointer reached the target.
    const tracker = new CursorTracker();
    let calls = 0;
    const page: CursorPage = {
      viewportSize: () => ({ width: 800, height: 600 }),
      mouse: {
        async move() {
          calls++;
          if (calls === 3) throw new Error('detached');
        },
        async down() {
          return undefined;
        },
        async up() {
          return undefined;
        },
        async wheel() {
          return undefined;
        },
      },
    };
    await expect(
      moveTo(page, tracker, { x: 700, y: 500 }, { rng: seededRng('fail'), sleep: noSleep }),
    ).rejects.toThrow('detached');
    const recorded = tracker.get(page, { width: 800, height: 600 }, seededRng('x'));
    expect(recorded).not.toEqual({ x: 700, y: 500 });
  });

  it('survives a page that reports no viewport', async () => {
    const { page, moves } = fakePage(null);
    await moveTo(
      page,
      new CursorTracker(),
      { x: 100, y: 100 },
      { rng: seededRng('n'), sleep: noSleep },
    );
    expect(moves.length).toBeGreaterThan(0);
  });
});

describe('clickBox', () => {
  const box = { x: 100, y: 100, width: 200, height: 50 };

  it('moves first, then presses and releases with a held dwell in the 45–120 ms band', async () => {
    const { page, events } = fakePage();
    const slept: number[] = [];
    await clickBox(page, new CursorTracker(), box, {
      rng: seededRng('click'),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(events[0]).toBe('move');
    expect(events.filter((e) => e.startsWith('down:'))).toEqual(['down:left:1']);
    expect(events.filter((e) => e.startsWith('up:'))).toEqual(['up:left:1']);
    // The press must come after the movement, never before.
    expect(events.indexOf('down:left:1')).toBeGreaterThan(events.lastIndexOf('move'));
    const dwell = slept[slept.length - 1] ?? 0;
    expect(dwell).toBeGreaterThanOrEqual(45);
    expect(dwell).toBeLessThanOrEqual(120);
  });

  it('honours a caller-supplied position instead of sampling one', async () => {
    const { page, moves } = fakePage();
    await clickBox(page, new CursorTracker(), box, {
      rng: seededRng('pos'),
      sleep: noSleep,
      position: { x: 10, y: 5 },
    });
    expect(moves[moves.length - 1]).toEqual({ x: 110, y: 105 });
  });

  it('emits an incrementing clickCount for a multi-click', async () => {
    const { page, events } = fakePage();
    await clickBox(page, new CursorTracker(), box, {
      rng: seededRng('multi'),
      sleep: noSleep,
      clickCount: 2,
    });
    expect(events.filter((e) => e.startsWith('down:'))).toEqual(['down:left:1', 'down:left:2']);
  });

  it('passes the requested button through', async () => {
    const { page, events } = fakePage();
    await clickBox(page, new CursorTracker(), box, {
      rng: seededRng('btn'),
      sleep: noSleep,
      button: 'right',
    });
    expect(events).toContain('down:right:1');
  });
});

describe('scrollBy', () => {
  it('splits the delta into 3–7 wheel notches that sum exactly, pausing 40–90 ms between', async () => {
    // Splitting matches how a wheel or trackpad actually delivers scroll; the exact sum matters
    // because callers read back the resulting offset.
    for (let i = 0; i < 20; i++) {
      const { page, wheels } = fakePage();
      const slept: number[] = [];
      await scrollBy(page, 0, 900, {
        rng: seededRng(`s${i}`),
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
      expect(wheels.length).toBeGreaterThanOrEqual(3);
      expect(wheels.length).toBeLessThanOrEqual(7);
      expect(wheels.reduce((sum, [, dy]) => sum + dy, 0)).toBe(900);
      for (const ms of slept) {
        expect(ms).toBeGreaterThanOrEqual(40);
        expect(ms).toBeLessThanOrEqual(90);
      }
    }
  });

  it('handles a negative delta and a zero delta', async () => {
    const up = fakePage();
    await scrollBy(up.page, 0, -300, { rng: seededRng('up'), sleep: noSleep });
    expect(up.wheels.reduce((sum, [, dy]) => sum + dy, 0)).toBe(-300);

    const none = fakePage();
    await scrollBy(none.page, 0, 0, { rng: seededRng('zero'), sleep: noSleep });
    expect(none.wheels).toEqual([]);
  });
});

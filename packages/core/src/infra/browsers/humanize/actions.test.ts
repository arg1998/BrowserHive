/** @module infra/browsers/humanize/actions.test — humanClick/hover/type/scroll policy: budgets and native fallbacks. */

import { describe, expect, it } from 'bun:test';
import {
  type ActionPage,
  BUDGET_FRACTION,
  estimateTypingMs,
  humanClick,
  humanHover,
  humanScroll,
  humanType,
  MAX_HUMANIZED_CHARS,
  POINTER_ESTIMATE_MS,
} from './actions.ts';
import type { BoundingBox } from './cursor.ts';
import { CursorTracker } from './cursor.ts';
import { seededRng } from './rng.ts';

/** A fake page whose locator resolves to `box` (or throws when `null`). */
function fakePage(box: BoundingBox | null) {
  const events: string[] = [];
  const typed: string[] = [];
  const page: ActionPage = {
    viewportSize: () => ({ width: 1280, height: 800 }),
    mouse: {
      move: async () => {
        events.push('move');
      },
      down: async () => {
        events.push('down');
      },
      up: async () => {
        events.push('up');
      },
      wheel: async (_dx, dy) => {
        events.push(`wheel:${dy}`);
      },
    },
    keyboard: {
      type: async (text) => {
        typed.push(text);
      },
      press: async (key) => {
        events.push(`press:${key}`);
      },
      down: async (key) => {
        events.push(`kdown:${key}`);
      },
      up: async (key) => {
        events.push(`kup:${key}`);
      },
    },
    locator: () => ({
      scrollIntoViewIfNeeded: async () => {
        if (box === null) throw new Error('element is not visible');
      },
      boundingBox: async () => box,
    }),
  };
  return { page, events, typed };
}

const noSleep = async (): Promise<void> => undefined;
const BOX: BoundingBox = { x: 100, y: 100, width: 200, height: 40 };

describe('policy constants (spec 02 §7)', () => {
  it('pins the values', () => {
    expect(MAX_HUMANIZED_CHARS).toBe(400);
    expect(BUDGET_FRACTION).toBe(0.6);
    expect(POINTER_ESTIMATE_MS).toBe(1200);
    expect(estimateTypingMs('abc')).toBe(Math.round(3 * 130 * 1.2));
    expect(estimateTypingMs('x'.repeat(1000))).toBe(Math.round(400 * 130 * 1.2));
  });
});

describe('humanClick', () => {
  it('drives a curved path then presses, wrapping modifiers around the click', async () => {
    const { page, events } = fakePage(BOX);
    let native = 0;
    await humanClick({
      page,
      tracker: new CursorTracker(),
      rng: seededRng('c'),
      sleep: noSleep,
      timeout: 30_000,
      selector: '#btn',
      modifiers: ['Control', 'Shift'],
      native: async () => {
        native++;
      },
    });
    expect(native).toBe(0);
    expect(events.filter((e) => e === 'move').length).toBeGreaterThan(5);
    expect(events[0]).toBe('kdown:Control');
    expect(events[1]).toBe('kdown:Shift');
    expect(events.slice(-2)).toEqual(['kup:Shift', 'kup:Control']);
    expect(events.indexOf('down')).toBeGreaterThan(events.lastIndexOf('move'));
  });

  it('falls back to native when the element has no box (so Playwright reports the real error)', async () => {
    const { page, events } = fakePage(null);
    let native = 0;
    await humanClick({
      page,
      tracker: new CursorTracker(),
      rng: seededRng('c'),
      sleep: noSleep,
      timeout: 30_000,
      selector: '#hidden',
      native: async () => {
        native++;
      },
    });
    expect(native).toBe(1);
    expect(events).toEqual([]);
  });

  it('falls back to native when the budget cannot fit a pointer movement; 0 means no timeout', async () => {
    const tight = fakePage(BOX);
    let native = 0;
    await humanClick({
      page: tight.page,
      tracker: new CursorTracker(),
      rng: seededRng('c'),
      sleep: noSleep,
      timeout: 1_000, // 1000 * 0.6 < 1200
      selector: '#btn',
      native: async () => {
        native++;
      },
    });
    expect(native).toBe(1);
    expect(tight.events).toEqual([]);
    const unlimited = fakePage(BOX);
    await humanClick({
      page: unlimited.page,
      tracker: new CursorTracker(),
      rng: seededRng('c'),
      sleep: noSleep,
      timeout: 0,
      selector: '#btn',
      native: async () => {
        native++;
      },
    });
    expect(native).toBe(1);
    expect(unlimited.events).toContain('down');
  });
});

describe('humanHover', () => {
  it('moves without pressing, and falls back like click', async () => {
    const { page, events } = fakePage(BOX);
    await humanHover({
      page,
      tracker: new CursorTracker(),
      rng: seededRng('h'),
      sleep: noSleep,
      timeout: 30_000,
      selector: '#x',
      native: async () => undefined,
    });
    expect(events.every((e) => e === 'move')).toBe(true);
    expect(events.length).toBeGreaterThan(5);
    let native = 0;
    await humanHover({
      page: fakePage(null).page,
      tracker: new CursorTracker(),
      rng: seededRng('h'),
      sleep: noSleep,
      timeout: 30_000,
      selector: '#x',
      native: async () => {
        native++;
      },
    });
    expect(native).toBe(1);
  });
});

describe('humanType', () => {
  it('focuses, types the exact text with a cadence, and reports progress', async () => {
    const { page, typed } = fakePage(BOX);
    const slept: number[] = [];
    const progress: [number, number][] = [];
    let focused = 0;
    await humanType({
      page,
      tracker: new CursorTracker(),
      rng: seededRng('t'),
      sleep: async (ms) => {
        slept.push(ms);
      },
      timeout: 30_000,
      selector: '#name',
      text: 'hello there friend',
      focus: async () => {
        focused++;
      },
      native: async () => {
        throw new Error('should not fall back');
      },
      onProgress: (a, b) => void progress.push([a, b]),
    });
    expect(focused).toBe(1);
    // Backspaces are pressed, not typed, so a typo never lands in the field.
    expect(typed.join('').length).toBeGreaterThanOrEqual('hello there friend'.length);
    expect(slept.length).toBeGreaterThan(5);
    expect(new Set(slept).size).toBeGreaterThan(3);
    expect(progress[progress.length - 1]).toEqual([18, 18]);
  });

  it('types text beyond MAX_HUMANIZED_CHARS natively, split on code points', async () => {
    const { page, typed } = fakePage(BOX);
    const text = `${'a'.repeat(MAX_HUMANIZED_CHARS - 1)}🙂zz`;
    await humanType({
      page,
      tracker: new CursorTracker(),
      rng: seededRng('t'),
      sleep: noSleep,
      timeout: 0,
      selector: '#name',
      text,
      focus: async () => undefined,
      native: async () => undefined,
      typing: { typoRate: 0 },
    });
    expect(typed[typed.length - 1]).toBe('zz');
    expect(typed.join('')).toBe(text);
  });

  it('falls back to native when the budget is below 25 × chars × 0.25 ms', async () => {
    const { page, typed } = fakePage(BOX);
    let native = 0;
    await humanType({
      page,
      tracker: new CursorTracker(),
      rng: seededRng('t'),
      sleep: noSleep,
      timeout: 100, // budget 60 ms < 25 * 20 * 0.25 = 125
      selector: '#name',
      text: 'twenty characters!!!',
      focus: async () => undefined,
      native: async () => {
        native++;
      },
    });
    expect(native).toBe(1);
    expect(typed).toEqual([]);
  });
});

describe('humanScroll', () => {
  it('delivers the delta as wheel notches', async () => {
    const { page, events } = fakePage(BOX);
    await humanScroll({ page, rng: seededRng('s'), sleep: noSleep, deltaX: 0, deltaY: 600 });
    const total = events
      .filter((e) => e.startsWith('wheel:'))
      .reduce((sum, e) => sum + Number(e.slice('wheel:'.length)), 0);
    expect(total).toBe(600);
  });
});

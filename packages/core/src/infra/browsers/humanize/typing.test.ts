/** @module infra/browsers/humanize/typing.test — typing plan (cadence, pauses, typo model, budget) and performTyping. */

import { describe, expect, it } from 'bun:test';
import { seededRng } from './rng.ts';
import {
  DEFAULT_TYPING_OPTIONS,
  fitToBudget,
  neighbourKey,
  performTyping,
  planDuration,
  planTyping,
  type TypingAction,
  type TypingKeyboard,
} from './typing.ts';

/** Reassemble what a plan would leave in the field, honouring backspaces. */
function render(actions: readonly TypingAction[]): string {
  let out = '';
  for (const action of actions) {
    if (action.kind === 'text') out += action.text;
    else if (action.key === 'Backspace') out = out.slice(0, -1);
  }
  return out;
}

describe('neighbourKey', () => {
  it('returns a physically adjacent key, preserving case', () => {
    // A typo that lands across the keyboard is noise, not a typo — the correction only reads as
    // human if the error does.
    const rng = seededRng('neighbour');
    for (let i = 0; i < 50; i++) {
      expect('qwsz').toContain(neighbourKey('a', rng) ?? '?');
      expect('QWSZ').toContain(neighbourKey('A', rng) ?? '?');
    }
  });

  it('returns undefined for characters with no modelled neighbour', () => {
    const rng = seededRng('none');
    expect(neighbourKey('é', rng)).toBeUndefined();
    expect(neighbourKey('!', rng)).toBeUndefined();
    expect(neighbourKey(' ', rng)).toBeUndefined();
  });
});

describe('planTyping', () => {
  it('always renders exactly the requested text, typos included', () => {
    // Every typo must be corrected; a plan that leaves a mistyped credential in the field is a bug
    // with real consequences, so this is checked at a high typo rate across many seeds.
    for (let i = 0; i < 60; i++) {
      const text = 'Hello, world! The quick brown fox jumps over 13 lazy dogs.';
      const plan = planTyping(text, seededRng(`seed-${i}`), { typoRate: 0.35 });
      expect(render(plan)).toBe(text);
    }
  });

  it('handles an empty string and non-Latin text without corrupting it', () => {
    expect(planTyping('', seededRng('a'))).toEqual([]);
    const unicode = 'こんにちは 🙂 café';
    expect(render(planTyping(unicode, seededRng('b'), { typoRate: 0.4 }))).toBe(unicode);
  });

  it('starts with no delay and keeps every later delay inside the configured bounds', () => {
    const plan = planTyping('some reasonably long input text', seededRng('bounds'));
    expect(plan[0]?.delayMs).toBe(0);
    for (const action of plan.slice(1)) {
      expect(action.delayMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(action.delayMs)).toBe(true);
    }
  });

  it('is deterministic for a seed (one consistent hand per session)', () => {
    const text = 'the same text';
    expect(planTyping(text, seededRng('hand'))).toEqual(planTyping(text, seededRng('hand')));
    expect(planTyping(text, seededRng('hand'))).not.toEqual(planTyping(text, seededRng('other')));
  });

  it('pauses longer after a word boundary than mid-word', () => {
    // Flat inter-key timing across a whole string is a tell no amount of per-key jitter hides.
    const rng = seededRng('pauses');
    const plan = planTyping('aaaa bbbb cccc dddd eeee ffff gggg hhhh', rng, { typoRate: 0 });
    const afterSpace: number[] = [];
    const midWord: number[] = [];
    const chars = [...'aaaa bbbb cccc dddd eeee ffff gggg hhhh'];
    plan.forEach((action, i) => {
      if (i === 0 || action.kind !== 'text') return;
      (chars[i - 1] === ' ' ? afterSpace : midWord).push(action.delayMs);
    });
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(afterSpace)).toBeGreaterThan(mean(midWord));
  });

  it('emits a Backspace correction whenever it emits a typo, with the notice pause in 120–380 ms', () => {
    const plan = planTyping('aaaaaaaaaaaaaaaaaaaa', seededRng('typo'), { typoRate: 1 });
    const backspaces = plan.filter((a) => a.kind === 'key' && a.key === 'Backspace');
    expect(backspaces).toHaveLength(20);
    for (const b of backspaces) {
      expect(b.delayMs).toBeGreaterThanOrEqual(120);
      expect(b.delayMs).toBeLessThanOrEqual(380);
    }
    expect(render(plan)).toBe('aaaaaaaaaaaaaaaaaaaa');
  });

  it('compresses uniformly to fit a budget, preserving relative structure', () => {
    const text = 'a fairly long line of text that would take a while to type by hand';
    const natural = planTyping(text, seededRng('budget'), { typoRate: 0 });
    const fitted = planTyping(text, seededRng('budget'), { typoRate: 0 }, 500);
    expect(planDuration(natural)).toBeGreaterThan(500);
    expect(planDuration(fitted)).toBeLessThanOrEqual(510); // rounding slack
    expect(render(fitted)).toBe(text);
    expect(fitted).toHaveLength(natural.length);
  });

  it('leaves a plan alone when it already fits', () => {
    const plan = planTyping('hi', seededRng('fits'), { typoRate: 0 }, 60_000);
    expect(planDuration(plan)).toBeLessThan(60_000);
  });
});

describe('fitToBudget', () => {
  it('is a no-op on an empty or already-small plan', () => {
    expect(fitToBudget([], 100)).toEqual([]);
    const plan: TypingAction[] = [{ kind: 'text', text: 'a', delayMs: 10 }];
    expect(fitToBudget(plan, 100)).toEqual(plan);
  });
});

describe('performTyping', () => {
  it('sleeps each delay first, then emits the action, in order', async () => {
    const events: string[] = [];
    const keyboard: TypingKeyboard = {
      type: async (text) => {
        events.push(`type:${text}`);
      },
      press: async (key) => {
        events.push(`press:${key}`);
      },
    };
    const plan: TypingAction[] = [
      { kind: 'text', text: 'a', delayMs: 0 },
      { kind: 'text', text: 'x', delayMs: 5 },
      { kind: 'key', key: 'Backspace', delayMs: 7 },
      { kind: 'text', text: 'b', delayMs: 3 },
    ];
    await performTyping(keyboard, plan, async (ms) => {
      events.push(`sleep:${ms}`);
    });
    expect(events).toEqual([
      'type:a',
      'sleep:5',
      'type:x',
      'sleep:7',
      'press:Backspace',
      'sleep:3',
      'type:b',
    ]);
  });

  it('never sleeps for a zero delay', async () => {
    const slept: number[] = [];
    await performTyping(
      { type: async () => undefined, press: async () => undefined },
      [{ kind: 'text', text: 'a', delayMs: 0 }],
      async (ms) => {
        slept.push(ms);
      },
    );
    expect(slept).toEqual([]);
  });
});

describe('DEFAULT_TYPING_OPTIONS', () => {
  it('pins the default constants (spec 02 §7)', () => {
    expect(DEFAULT_TYPING_OPTIONS).toEqual({
      medianIntervalMs: 130,
      sigma: 0.38,
      wordPauseMs: 90,
      sentencePauseMs: 260,
      typoRate: 0.03,
      typoNoticeMs: { min: 120, max: 380 },
      intervalBounds: { min: 25, max: 900 },
    });
  });
});

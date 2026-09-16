/** @module test/composition/unwind.test — reverse order, per-handle budgets, failures and overruns never stop the unwind, a second unwind is a no-op. */

import { describe, expect, it } from 'bun:test';
import { UnwindStack } from '../../src/composition/unwind.ts';

const clock = { now: () => Date.now() };

describe('UnwindStack', () => {
  it('stops in reverse order, isolating failures and timeouts', async () => {
    const order: string[] = [];
    const stack = new UnwindStack();
    stack.push('a', { stop: async () => void order.push('a') }, 1000);
    stack.push(
      'b',
      {
        stop: async () => {
          order.push('b');
          throw new Error('b failed');
        },
      },
      1000,
    );
    stack.push('c', { stop: () => new Promise(() => order.push('c')) }, 300);
    const budgets: number[] = [];
    stack.push('d', { stop: async (ms) => void budgets.push(ms) }, 50_000);
    const steps = await stack.unwind({ deadlineMs: 5_000, clock });
    expect(order).toEqual(['c', 'b', 'a']);
    expect(steps.map((s) => [s.name, s.outcome])).toEqual([
      ['d', 'ok'],
      ['c', 'timeout'],
      ['b', 'failed'],
      ['a', 'ok'],
    ]);
    expect(budgets[0]).toBeLessThanOrEqual(5_000);
    expect(stack.size).toBe(0);
    expect(await stack.unwind({ deadlineMs: 5_000, clock })).toEqual([]);
  });
});

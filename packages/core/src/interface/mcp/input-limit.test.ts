/** @module interface/mcp/input-limit.test — the tool-input element cap counts array elements and object members at every depth. */

import { describe, expect, it } from 'bun:test';
import { exceedsInputElements } from './input-limit.ts';

describe('exceedsInputElements', () => {
  it('counts array elements and object members at every depth', () => {
    const value = { a: [1, 2, { b: 3 }], c: { d: null } };
    // a, c, 1, 2, {b}, b, d
    expect(exceedsInputElements(value, 7)).toBe(false);
    expect(exceedsInputElements(value, 6)).toBe(true);
  });

  it('treats scalars and absent arguments as empty', () => {
    expect(exceedsInputElements(undefined, 0)).toBe(false);
    expect(exceedsInputElements('text', 0)).toBe(false);
    expect(exceedsInputElements({}, 0)).toBe(false);
  });

  it('handles deep nesting without recursion', () => {
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(exceedsInputElements(deep, 100_000)).toBe(false);
    expect(exceedsInputElements(deep, 99_999)).toBe(true);
  });
});

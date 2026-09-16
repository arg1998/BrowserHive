/** @module kernel/secret.test — Secret<T> refuses every implicit rendering path. */

import { describe, expect, it } from 'bun:test';
import { inspect } from 'node:util';
import { isSecret, SECRET_PLACEHOLDER, secret, unwrapSecret } from './secret.ts';

describe('Secret', () => {
  const s = secret('hunter2');

  it('hides the value from JSON.stringify', () => {
    expect(JSON.stringify({ password: s })).toBe(`{"password":"${SECRET_PLACEHOLDER}"}`);
  });

  it('hides the value from template literals and String()', () => {
    expect(`${s}`).toBe(SECRET_PLACEHOLDER);
    expect(String(s)).toBe(SECRET_PLACEHOLDER);
    expect(`${s}`.includes('hunter2')).toBe(false);
  });

  it('hides the value from util.inspect', () => {
    expect(inspect(s)).toBe(SECRET_PLACEHOLDER);
    expect(inspect({ nested: s })).not.toContain('hunter2');
  });

  it('does not expose the value as an own enumerable property', () => {
    expect(Object.keys(s)).toEqual([]);
    expect(Object.values(s)).toEqual([]);
  });

  it('reveals only through reveal()/unwrapSecret', () => {
    expect(s.reveal()).toBe('hunter2');
    expect(unwrapSecret(s)).toBe('hunter2');
    expect(unwrapSecret('plain')).toBe('plain');
    expect(isSecret(s)).toBe(true);
    expect(isSecret('hunter2')).toBe(false);
  });
});

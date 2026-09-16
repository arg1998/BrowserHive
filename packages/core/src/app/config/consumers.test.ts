/** @module app/config/consumers.test — unit tests for consumers */
import { describe, expect, it } from 'bun:test';
import { CONFIG_KEYS, keyMeta } from '@browserhive/contracts/config';
import { CONSUMED_KEYS } from './consumers.ts';

describe('CONSUMED_KEYS (dead-key gate, spec 08 §6)', () => {
  it('names a consumer module for every registered key and nothing else', () => {
    const consumed = Object.keys(CONSUMED_KEYS).sort();
    expect(consumed).toEqual([...CONFIG_KEYS].sort());
  });

  it('every consumer is a module path, never empty', () => {
    for (const key of CONFIG_KEYS) {
      expect(CONSUMED_KEYS[key]).toMatch(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/);
    }
  });

  it('defaultHeadless, defaultChannel, allowEvaluate and captcha have a consumer outside the resolver', () => {
    for (const key of ['defaultHeadless', 'defaultChannel', 'allowEvaluate', 'captcha'] as const) {
      expect(CONSUMED_KEYS[key]).not.toBe('app/config/resolve');
    }
  });

  it('every key with a default or derivation has a describe line for --help', () => {
    for (const key of CONFIG_KEYS) expect(keyMeta(key).describe.length).toBeGreaterThan(0);
  });
});

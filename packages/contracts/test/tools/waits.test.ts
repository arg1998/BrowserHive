/** @module contracts/test/tools/waits.test — wait tool defaults and enums */
/// <reference types="bun-types" />
import { describe, expect, it } from 'bun:test';
import { WAIT_FOR_URL } from '../../src/tools/navigation.ts';
import { WAIT_FOR_LOAD_STATE, WAIT_FOR_SELECTOR } from '../../src/tools/waits.ts';

describe('wait_for_selector', () => {
  it('defaults state=visible and timeout=30000; rejects unknown states and empty selectors', () => {
    expect(WAIT_FOR_SELECTOR.input.parse({ session_id: 's', selector: '#a' })).toEqual({
      session_id: 's',
      selector: '#a',
      state: 'visible',
      timeout: 30_000,
    });
    expect(
      WAIT_FOR_SELECTOR.input.safeParse({ session_id: 's', selector: '#a', state: 'gone' }).success,
    ).toBe(false);
    expect(WAIT_FOR_SELECTOR.input.safeParse({ session_id: 's', selector: '' }).success).toBe(
      false,
    );
    expect(
      WAIT_FOR_SELECTOR.input.safeParse({ session_id: 's', selector: '#a', timeout: -1 }).success,
    ).toBe(false);
    expect(
      WAIT_FOR_SELECTOR.input.safeParse({ session_id: 's', selector: '#a', timeout: 0 }).success,
    ).toBe(true);
  });
});

describe('wait_for_load_state', () => {
  it('defaults state=load and excludes commit', () => {
    expect(WAIT_FOR_LOAD_STATE.input.parse({ session_id: 's' })).toEqual({
      session_id: 's',
      state: 'load',
      timeout: 30_000,
    });
    expect(WAIT_FOR_LOAD_STATE.input.safeParse({ session_id: 's', state: 'commit' }).success).toBe(
      false,
    );
  });
});

describe('wait_for_url', () => {
  it('accepts a string or a { pattern, flags? } object', () => {
    expect(WAIT_FOR_URL.input.parse({ session_id: 's', url: 'https://x.test/**' })).toEqual({
      session_id: 's',
      url: 'https://x.test/**',
      timeout: 30_000,
    });
    expect(
      WAIT_FOR_URL.input.parse({ session_id: 's', url: { pattern: 'x', flags: 'i' } }).url,
    ).toEqual({ pattern: 'x', flags: 'i' });
    expect(WAIT_FOR_URL.input.safeParse({ session_id: 's', url: { pattern: '' } }).success).toBe(
      false,
    );
  });
});

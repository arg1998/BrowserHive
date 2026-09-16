/** @module infra/ids/ulid.test — monotonic ULID encoding. */

import { describe, expect, it } from 'bun:test';
import { createUlidFactory, isUlid } from './ulid.ts';

describe('createUlidFactory', () => {
  it('mints 26-char Crockford base32 ids', () => {
    const ulid = createUlidFactory({ now: () => 1_700_000_000_000 });
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it('encodes the timestamp in the first 10 chars', () => {
    const ulid = createUlidFactory({ now: () => 0, randomBytes: () => new Uint8Array(10) });
    expect(ulid()).toBe('0000000000'.padEnd(26, '0'));
    const at = createUlidFactory({
      now: () => 1_469_918_176_385,
      randomBytes: () => new Uint8Array(10),
    });
    // Reference vector from the ULID spec: 1469918176385 → 01ARYZ6S41.
    expect(at().slice(0, 10)).toBe('01ARYZ6S41');
  });

  it('is monotonic within the same millisecond and sorts by creation', () => {
    const ulid = createUlidFactory({
      now: () => 5,
      randomBytes: () => new Uint8Array(10).fill(0x7f),
    });
    const first = ulid();
    const second = ulid();
    const third = ulid();
    expect(first < second).toBe(true);
    expect(second < third).toBe(true);
  });

  it('stays monotonic when the clock goes backwards', () => {
    let now = 100;
    const ulid = createUlidFactory({ now: () => now });
    const a = ulid();
    now = 50;
    const b = ulid();
    expect(a < b).toBe(true);
    expect(b.slice(0, 10)).toBe(a.slice(0, 10));
  });

  it('draws new entropy for a new millisecond', () => {
    let now = 1;
    let draws = 0;
    const ulid = createUlidFactory({
      now: () => now,
      randomBytes: () => {
        draws += 1;
        return new Uint8Array(10).fill(draws);
      },
    });
    ulid();
    ulid();
    now = 2;
    ulid();
    expect(draws).toBe(2);
  });

  it('uses crypto.getRandomValues by default and varies across calls', () => {
    let now = 1;
    const ulid = createUlidFactory({ now: () => now });
    const a = ulid();
    now = 2;
    const b = ulid();
    expect(a.slice(10)).not.toBe(b.slice(10));
  });
});

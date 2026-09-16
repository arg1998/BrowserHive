/** @module kernel/duration.test — duration formatting. */

import { describe, expect, it } from 'bun:test';
import { formatDuration } from './duration.ts';

describe('formatDuration', () => {
  it('compact style', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(-1)).toBe('0ms');
    expect(formatDuration(412)).toBe('412ms');
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(1234)).toBe('1.2s');
    expect(formatDuration(9000)).toBe('9s');
    expect(formatDuration(9950)).toBe('9.9s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(4 * 60_000 + 12_000)).toBe('4m 12s');
    expect(formatDuration(3_600_000 + 3 * 60_000)).toBe('1h 03m');
  });

  it('clock style', () => {
    expect(formatDuration(0, { style: 'clock' })).toBe('0:00:00');
    expect(formatDuration(65_000, { style: 'clock' })).toBe('0:01:05');
    expect(formatDuration(3_725_000, { style: 'clock' })).toBe('1:02:05');
  });
});

/** @module kernel/bytes.test — byte formatting. */

import { describe, expect, it } from 'bun:test';
import { formatBytes } from './bytes.ts';

describe('formatBytes', () => {
  it('renders decimal units with one decimal place', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 kB');
    expect(formatBytes(18_400_000)).toBe('18.4 MB');
    expect(formatBytes(1_200_000_000)).toBe('1.2 GB');
    expect(formatBytes(5e15)).toBe('5.0 PB');
  });

  it('supports binary units and digits', () => {
    expect(formatBytes(1024, { unit: 'binary' })).toBe('1.0 KiB');
    expect(formatBytes(1_073_741_824, { unit: 'binary', digits: 0 })).toBe('1 GiB');
  });

  it('renders garbage as 0 B', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

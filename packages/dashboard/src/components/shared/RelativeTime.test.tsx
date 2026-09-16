/** @module components/shared/RelativeTime.test — server-anchored relative text with an absolute tooltip */

import { describe, expect, it } from 'bun:test';
import { formatDuration, formatRelative } from '@/lib/format/time.ts';
import { render, screen } from '../../../test/helpers/render.tsx';
import { RelativeTime } from './RelativeTime.tsx';

const NOW = 1_700_000_000_000;

describe('RelativeTime', () => {
  it('formats relative to the anchored server clock', () => {
    render(<RelativeTime at={NOW - 5 * 60_000} />);
    const time = screen.getByText('5m ago');
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('data-absolute')).toContain('2023');
    expect(time.getAttribute('datetime')).toBe(new Date(NOW - 5 * 60_000).toISOString());
  });

  it('formats durations as compact units and handles future/day scales', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(9_000)).toBe('9s');
    expect(formatDuration(4 * 60_000 + 12_000)).toBe('4m 12s');
    expect(formatDuration(3_600_000 + 3 * 60_000)).toBe('1h 03m');
    expect(formatRelative(NOW - 10_000, NOW)).toBe('just now');
    expect(formatRelative(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
    expect(formatRelative(NOW + 2 * 3_600_000, NOW)).toBe('in 2h');
  });
});

/** @module interface/mcp/tools/inspection/paging.test — pageText: exact reassembly, never a split surrogate pair, progress on tiny pages, offsets past the end. */

import { describe, expect, it } from 'bun:test';
import { pageText } from './paging.ts';

/** Every page from offset 0 along next_offset. */
function allPages(text: string, maxChars: number): string[] {
  const pages: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = pageText(text, offset, maxChars);
    pages.push(page.chunk);
    offset = page.next_offset;
    if (pages.length > text.length + 2) throw new Error('paging made no progress');
  }
  return pages;
}

/** True when `s` has a lone surrogate half. */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

describe('pageText', () => {
  it('returns the whole text in one page when it fits', () => {
    expect(pageText('hello', 0, 10)).toEqual({
      chunk: 'hello',
      total_chars: 5,
      truncated: false,
      next_offset: null,
    });
  });

  it('cuts at max_chars and reassembles exactly', () => {
    const text = 'abcdefghij'.repeat(7);
    expect(pageText(text, 0, 30)).toMatchObject({ truncated: true, next_offset: 30 });
    expect(allPages(text, 30).join('')).toBe(text);
  });

  it('never splits a surrogate pair, for every page size', () => {
    const text = 'a😀b😀😀c🎉'.repeat(5);
    for (let size = 1; size <= 9; size += 1) {
      const pages = allPages(text, size);
      expect(pages.join('')).toBe(text);
      for (const page of pages) {
        expect(hasLoneSurrogate(page)).toBe(false);
        expect(page.length).toBeGreaterThan(0);
        // One over only when a single pair does not fit.
        expect(page.length).toBeLessThanOrEqual(Math.max(size, 2));
      }
    }
  });

  it('moves an offset inside a pair back to its start', () => {
    const text = 'x😀y';
    expect(pageText(text, 2, 10)).toMatchObject({ chunk: '😀y', next_offset: null });
  });

  it('answers an empty final page at or past the end', () => {
    expect(pageText('abc', 3, 10)).toEqual({
      chunk: '',
      total_chars: 3,
      truncated: false,
      next_offset: null,
    });
    expect(pageText('abc', 99, 10)).toMatchObject({ chunk: '', next_offset: null });
  });
});

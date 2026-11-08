/** @module contracts/test/tools/inspection.test — the paging convention of get_content, get_text and snapshot: defaults, bounds, output fields */
/// <reference types="bun-types" />
import { describe, expect, it } from 'bun:test';
import {
  GET_CONTENT,
  GET_TEXT,
  GET_TEXT_DEFAULT_MAX_CHARS,
  PAGE_READ_DEFAULT_MAX_CHARS,
  PAGE_READ_MAX_CHARS_LIMIT,
  SNAPSHOT,
} from '../../src/tools/inspection.ts';

describe('reading tools paging', () => {
  it('defaults max_chars per tool and offset to 0', () => {
    expect(GET_TEXT.input.parse({ session_id: 's' })).toEqual({
      session_id: 's',
      max_chars: GET_TEXT_DEFAULT_MAX_CHARS,
      offset: 0,
    });
    for (const tool of [GET_CONTENT, SNAPSHOT]) {
      expect(tool.input.parse({ session_id: 's' })).toEqual({
        session_id: 's',
        max_chars: PAGE_READ_DEFAULT_MAX_CHARS,
        offset: 0,
      });
    }
    expect(GET_TEXT_DEFAULT_MAX_CHARS).toBe(20_000);
    expect(PAGE_READ_DEFAULT_MAX_CHARS).toBe(60_000);
  });

  it('bounds max_chars, rejects negative offsets and empty selectors', () => {
    for (const tool of [GET_CONTENT, GET_TEXT, SNAPSHOT]) {
      const max = PAGE_READ_MAX_CHARS_LIMIT;
      expect(tool.input.safeParse({ session_id: 's', max_chars: max }).success).toBe(true);
      expect(tool.input.safeParse({ session_id: 's', max_chars: max + 1 }).success).toBe(false);
      expect(tool.input.safeParse({ session_id: 's', max_chars: 0 }).success).toBe(false);
      expect(tool.input.safeParse({ session_id: 's', offset: -1 }).success).toBe(false);
      expect(tool.input.safeParse({ session_id: 's', selector: '' }).success).toBe(false);
      expect(tool.input.safeParse({ session_id: 's', selector: 'main' }).success).toBe(true);
    }
  });

  it('returns the paging fields, next_offset null at the end', () => {
    const base = { session_id: 's', url: 'https://x.test', total_chars: 3, truncated: false };
    expect(GET_TEXT.output.safeParse({ ...base, text: 'abc', next_offset: null }).success).toBe(
      true,
    );
    expect(GET_CONTENT.output.safeParse({ ...base, html: 'abc', next_offset: 3 }).success).toBe(
      true,
    );
    expect(SNAPSHOT.output.safeParse({ ...base, tree: 'abc' }).success).toBe(false);
  });
});

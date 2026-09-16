/** @module app/search-params.test — list params serialise as readable comma lists, round-trip through `csvParam`, and JSON-array links still parse */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { csvParam } from '@/lib/search/table.ts';
import { parseSearch, stringifySearch } from './search-params.ts';

describe('search params', () => {
  it('writes arrays of plain values as comma lists and keeps key order', () => {
    expect(stringifySearch({ page: 2, level: ['warn', 'error'], q: 'a b', kinds: ['tool'] })).toBe(
      '?page=2&level=warn,error&q=a+b&kinds=tool',
    );
    expect(stringifySearch({})).toBe('');
    expect(stringifySearch({ live: undefined })).toBe('');
  });

  it('falls back to JSON for items a comma list cannot hold', () => {
    const s = stringifySearch({ ids: ['a,b', 'c'] });
    expect(parseSearch(s)).toEqual({ ids: ['a,b', 'c'] });
  });

  it('round-trips through csvParam, including JSON-array links', () => {
    const schema = z.object({ level: csvParam(z.enum(['warn', 'error'])), page: z.number() });
    expect(
      schema.parse(parseSearch(stringifySearch({ level: ['warn', 'error'], page: 3 }))),
    ).toEqual({
      level: ['warn', 'error'],
      page: 3,
    });
    expect(schema.parse({ ...parseSearch('?level=%5B%22warn%22%5D'), page: 1 }).level).toEqual([
      'warn',
    ]);
  });
});

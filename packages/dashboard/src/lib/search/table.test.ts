/** @module lib/search/table.test — URL-state rules: defaults omitted, page reset, csv parsing, sort cycle, clamping (spec 04 §12) */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  applySearchPatch,
  clampPage,
  csvParam,
  nextSort,
  omitDefaults,
  TABLE_SEARCH_DEFAULTS,
  tableSearchSchema,
} from './table.ts';

describe('table search schema', () => {
  const schema = tableSearchSchema(['created', 'slug']);
  it('applies defaults and drops invalid values', () => {
    expect(schema.parse({})).toEqual({ page: 1, ps: 25 });
    expect(schema.parse({ page: '0', ps: '33', sort: 'nope', dir: 'up', q: '  ' })).toEqual({
      page: 1,
      ps: 25,
    });
    expect(schema.parse({ page: '3', ps: '100', sort: 'slug', dir: 'asc', q: ' x ' })).toEqual({
      page: 3,
      ps: 100,
      sort: 'slug',
      dir: 'asc',
      q: 'x',
    });
  });
  it('parses csv params from strings and arrays', () => {
    const p = z.object({ state: csvParam(z.enum(['live', 'closed'])) });
    expect(p.parse({ state: 'live,closed' })).toEqual({ state: ['live', 'closed'] });
    expect(p.parse({ state: ['closed'] })).toEqual({ state: ['closed'] });
    expect(p.parse({ state: '' })).toEqual({});
    expect(p.parse({ state: 'bogus' })).toEqual({});
  });
  it('drops only the invalid csv values', () => {
    const p = z.object({ state: csvParam(z.enum(['live', 'closed'])) });
    expect(p.parse({ state: 'live,bogus,closed' })).toEqual({ state: ['live', 'closed'] });
    expect(p.parse({ state: ['bogus', 'closed', ' '] })).toEqual({ state: ['closed'] });
    expect(p.parse({ state: 'bogus,nope' })).toEqual({});
  });
});

describe('search patches', () => {
  it('resets the page on any filter change and removes cleared keys', () => {
    const next = applySearchPatch(
      { page: 4, ps: 50, q: 'a', state: ['live'] },
      { q: 'b', state: [] },
    );
    expect(next as Record<string, unknown>).toEqual({ ps: 50, q: 'b' });
  });
  it('keeps the page when only the page changes', () => {
    expect(applySearchPatch({ page: 2, q: 'a' }, { page: 3 })).toEqual({ page: 3, q: 'a' });
  });
  it('omits defaults, empties and undefined', () => {
    expect(
      omitDefaults({ page: 1, ps: 25, q: '', state: [], sort: 'created' }, TABLE_SEARCH_DEFAULTS),
    ).toEqual({ sort: 'created' });
    expect(
      omitDefaults({ range: '7d', chart: 'collapsed' }, { range: '7d', chart: 'expanded' }),
    ).toEqual({ chart: 'collapsed' });
  });
  it('cycles sort none → desc → asc → none', () => {
    const a = nextSort({}, 'slug');
    expect(a).toEqual({ sort: 'slug', dir: 'desc' });
    const b = nextSort(a, 'slug');
    expect(b).toEqual({ sort: 'slug', dir: 'asc' });
    expect(nextSort(b, 'slug')).toEqual({ sort: undefined, dir: undefined });
    expect(nextSort(b, 'created')).toEqual({ sort: 'created', dir: 'desc' });
  });
  it('clamps out-of-range pages', () => {
    expect(clampPage(9, 60, 25)).toBe(3);
    expect(clampPage(0, 60, 25)).toBe(1);
    expect(clampPage(2, 0, 25)).toBe(1);
    expect(clampPage(7, undefined, 25)).toBe(7);
  });
});

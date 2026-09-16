/** @module features/sessions/search.test — `/sessions` URL rules: defaults omitted, comma lists, invalid values dropped, filter change resets page, sort cycle, REST query mapping */
import { describe, expect, it } from 'bun:test';
import { applySearchPatch, nextSort, omitDefaults } from '@/lib/search/table.ts';
import {
  hasSessionFilters,
  SESSIONS_DEFAULTS,
  sessionsKeyParams,
  sessionsSearch,
  toSessionsQuery,
} from './search.ts';

describe('sessions search schema', () => {
  it('applies defaults and parses comma lists', () => {
    const s = sessionsSearch.parse({ channel: 'chrome,edge', persistence: 'memory', view: 'live' });
    expect(s).toMatchObject({
      page: 1,
      ps: 25,
      view: 'live',
      channel: ['chrome', 'edge'],
      persistence: ['memory'],
    });
  });

  it('drops invalid values instead of failing', () => {
    const s = sessionsSearch.parse({
      view: 'nope',
      sort: 'bogus',
      ps: 33,
      page: -2,
      since: 'x',
      channel: 'firefox',
    });
    expect(s).toEqual({ page: 1, ps: 25 });
  });

  it('omits defaults from the URL', () => {
    expect(omitDefaults(sessionsSearch.parse({ q: 'shop' }), SESSIONS_DEFAULTS)).toEqual({
      q: 'shop',
    });
  });

  it('resets page on any filter or sort change but not on page moves', () => {
    const current = sessionsSearch.parse({ page: 4, q: 'a' });
    expect(applySearchPatch(current, { channel: ['chrome'] }).page).toBeUndefined();
    expect(applySearchPatch(current, { sort: 'slug', dir: 'desc' }).page).toBeUndefined();
    expect(applySearchPatch(current, { page: 5 }).page).toBe(5);
    expect(applySearchPatch(current, { channel: [] })).not.toHaveProperty('channel');
  });

  it('cycles sort none → desc → asc → none', () => {
    const a = nextSort({}, 'lease');
    expect(a).toEqual({ sort: 'lease', dir: 'desc' });
    const b = nextSort(a, 'lease');
    expect(b).toEqual({ sort: 'lease', dir: 'asc' });
    expect(nextSort(b, 'lease')).toEqual({ sort: undefined, dir: undefined });
  });

  it('maps URL keys onto the REST query', () => {
    const s = sessionsSearch.parse({
      sort: 'activity',
      dir: 'asc',
      persistence: 'persistent',
      archived: 'include',
      since: '10',
      ps: 50,
    });
    expect(toSessionsQuery(s, 'CUR')).toEqual({
      limit: 50,
      total: true,
      cursor: 'CUR',
      sort: 'last_activity_at',
      dir: 'asc',
      archived: 'include',
      persistence_mode: ['persistent'],
      since: 10,
    });
  });

  it('ignores a selection param in the URL (selection is local state) and drops default paging so the bridge sees clean first pages', () => {
    const s = sessionsSearch.parse({ sel: 'a,b' });
    expect(s).not.toHaveProperty('sel');
    expect(sessionsKeyParams(s, undefined)).toEqual({});
    expect(hasSessionFilters(s)).toBe(false);
    expect(hasSessionFilters(sessionsSearch.parse({ owner: 'x' }))).toBe(true);
  });
});

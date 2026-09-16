/** @module features/sessions/detail-search.test — session page search: alias tab links normalise onto the canonical tabs and filters, `?live=1` flags parse from hand-written URLs, tab switches drop tab-scoped keys */
import { describe, expect, it } from 'bun:test';
import {
  normalizeSessionSearchAliases,
  parseSessionPageSearch,
  sessionPageSearch,
  tabPatch,
} from './detail-search.ts';

describe('session page search', () => {
  it('maps alias tabs onto Activity filters, Details and the live pane', () => {
    expect(
      normalizeSessionSearchAliases({ tab: 'timeline', follow: '1', expanded: ['e-1'] }),
    ).toEqual({});
    expect(
      normalizeSessionSearchAliases({ tab: 'tools', ok: '0', sort: 'duration_ms', q: 'click' }),
    ).toEqual({
      kinds: ['tool'],
      errors_only: 1,
      q: 'click',
    });
    expect(normalizeSessionSearchAliases({ tab: 'pages', page: 2 })).toEqual({
      kinds: ['page'],
      page: 2,
    });
    expect(normalizeSessionSearchAliases({ tab: 'overview' })).toEqual({ tab: 'details' });
    expect(normalizeSessionSearchAliases({ tab: 'identity' })).toEqual({ tab: 'details' });
    expect(normalizeSessionSearchAliases({ tab: 'live', pane: 60 })).toEqual({ live: 1 });
    expect(normalizeSessionSearchAliases({ tab: 'screenshots', kind: 'trace' })).toEqual({
      tab: 'screenshots',
      shots: 'trace',
    });
  });

  it('leaves canonical URLs alone', () => {
    expect(normalizeSessionSearchAliases({})).toBeNull();
    expect(normalizeSessionSearchAliases({ tab: 'files' })).toBeNull();
    expect(normalizeSessionSearchAliases({ tab: 'activity', kinds: ['tool'], live: 1 })).toBeNull();
  });

  it('parses flags from typed and hand-written URLs and defaults the tab', () => {
    expect(sessionPageSearch.parse({ live: 1, takeover: '1', errors_only: true })).toMatchObject({
      tab: 'activity',
      live: 1,
      takeover: 1,
      errors_only: 1,
    });
    expect(sessionPageSearch.parse({ live: 0, tab: 'bogus' })).toMatchObject({ tab: 'activity' });
    expect(sessionPageSearch.parse({ live: 0 }).live).toBeUndefined();
    expect(parseSessionPageSearch({ tab: 'tools', ok: '0' })).toMatchObject({
      tab: 'activity',
      kinds: ['tool'],
      errors_only: 1,
    });
  });

  it('drops tab-scoped keys on a tab switch but keeps the live pane', () => {
    const patch = tabPatch('details');
    expect(patch).toMatchObject({
      tab: 'details',
      kinds: undefined,
      q: undefined,
      open: undefined,
    });
    expect(patch).not.toHaveProperty('live');
  });
});

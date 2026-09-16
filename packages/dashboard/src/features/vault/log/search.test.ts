/** @module features/vault/log/search.test — URL rules (csv parsing, invalid values, defaults), wire mapping, and live prepend only into the unfiltered default key */
import { describe, expect, it } from 'bun:test';
import type { WsFeedEvent } from '@browserhive/contracts/ws';
import { QueryClient } from '@tanstack/react-query';
import { keys } from '@/lib/api/keys.ts';
import { applyFeedEvent } from '@/lib/ws/bridge.ts';
import { envelope } from '../../../../test/helpers/page-harness.tsx';
import { accessRow } from '../fixtures.ts';
import { hasLogFilters, logKeyParams, logWireQuery, vaultLogSearch } from './search.ts';

describe('vault log search', () => {
  it('parses csv filters, drops invalid values and applies defaults', () => {
    const search = vaultLogSearch.parse({
      result: 'denied,blocked',
      origin_check: 'nope',
      evaluate: 'maybe',
      session: 'shop-ab12cd34',
      ps: '50',
      sort: 'bogus',
    });
    expect(search).toMatchObject({
      result: ['denied', 'blocked'],
      origin_check: undefined,
      evaluate: undefined,
      session: 'shop-ab12cd34',
      ps: 50,
      sort: undefined,
      page: 1,
      range: '7d',
    });
    expect(hasLogFilters(vaultLogSearch.parse({}))).toBe(false);
    expect(hasLogFilters(vaultLogSearch.parse({ range: '24h' }))).toBe(true);
    expect(hasLogFilters(search)).toBe(true);
  });

  it('maps URL keys to wire keys and resolves the window against now', () => {
    const now = 10 * 86_400_000;
    const wire = logWireQuery(
      vaultLogSearch.parse({
        sort: 'entry',
        dir: 'asc',
        entry: 'work.github',
        session: 'shop-ab12cd34',
        evaluate: 'on',
        range: '24h',
      }),
      now,
    );
    expect(wire).toEqual({
      limit: 25,
      total: true,
      sort: 'entry_name',
      dir: 'asc',
      evaluate: 'on',
      session_id: 'shop-ab12cd34',
      entry_name: 'work.github',
      since: now - 86_400_000,
      until: now,
    });
    expect(logWireQuery(vaultLogSearch.parse({ range: 'all' }), now)).toEqual({
      limit: 25,
      total: true,
      sort: 'ts',
      dir: 'desc',
    });
    expect(logWireQuery(vaultLogSearch.parse({ since: '5', until: '9' }), now)).toMatchObject({
      since: 5,
      until: 9,
    });
  });

  it('prepends vault.access into the default key and invalidates filtered keys', () => {
    const qc = new QueryClient();
    const clean = keys.vault.log(logKeyParams(vaultLogSearch.parse({})));
    const filtered = keys.vault.log(logKeyParams(vaultLogSearch.parse({ result: 'denied' })));
    expect(clean[2]).toEqual({ ps: 25 });
    qc.setQueryData(clean, envelope([accessRow()]));
    qc.setQueryData(filtered, envelope([]));
    const row = accessRow({ event_id: 'e-01HZX0000000000000000000BB', result: 'denied' });
    applyFeedEvent(
      qc,
      { type: 'vault.access', row } as unknown as WsFeedEvent,
      'session:shop-ab12cd34',
    );
    const data = qc.getQueryData<{ data: { event_id: string }[] }>(clean);
    expect(data?.data.map((r) => r.event_id)).toEqual([
      'e-01HZX0000000000000000000BB',
      'e-01HZX0000000000000000000AA',
    ]);
    expect(qc.getQueryState(filtered)?.isInvalidated).toBe(true);
  });
});

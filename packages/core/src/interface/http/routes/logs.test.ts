/** @module interface/http/routes/logs.test — `GET /logs`: newest-first paging to older records, `dir=asc`, `after_seq`, cursor/dir binding, and tolerant record serialization. */

import { describe, expect, it } from 'bun:test';
import { LogsPage } from '@browserhive/contracts/http';
import { NOW } from '../../../../test/helpers/http-fakes.ts';
import { createHttpKit, type HttpKit } from '../../../../test/helpers/http-kit.ts';

async function seeded(): Promise<{ kit: HttpKit; cookie: string }> {
  const kit = await createHttpKit();
  kit.logs.entries.length = 0;
  for (let seq = 1; seq <= 7; seq += 1) {
    kit.logs.entries.push({
      seq,
      record: { ts: NOW + seq, level: seq === 4 ? 'error' : 'info', msg: `m${seq}`, module: 'app' },
    });
  }
  return { kit, cookie: await kit.login() };
}

async function page(kit: HttpKit, cookie: string, query: string) {
  const res = await kit.request('GET', `/api/v1/logs${query}`, { cookie });
  expect(res.status).toBe(200);
  return LogsPage.parse(await res.json());
}

describe('GET /logs ordering and cursors', () => {
  it('defaults to newest first; next_cursor pages to older records', async () => {
    const { kit, cookie } = await seeded();
    const first = await page(kit, cookie, '?limit=3');
    expect(first.data.map((r) => r.seq)).toEqual([7, 6, 5]);
    expect(first.applied.sort).toEqual({ key: 'seq', dir: 'desc' });
    expect(first.latest_seq).toBe(7);
    const second = await page(kit, cookie, `?limit=3&cursor=${first.page.next_cursor}`);
    expect(second.data.map((r) => r.seq)).toEqual([4, 3, 2]);
    const third = await page(kit, cookie, `?limit=3&cursor=${second.page.next_cursor}`);
    expect(third.data.map((r) => r.seq)).toEqual([1]);
    expect(third.page.next_cursor).toBeNull();
  });

  it('dir=asc pages oldest to newest; after_seq bounds to newer records', async () => {
    const { kit, cookie } = await seeded();
    const asc = await page(kit, cookie, '?limit=4&dir=asc');
    expect(asc.data.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    const next = await page(kit, cookie, `?limit=4&dir=asc&cursor=${asc.page.next_cursor}`);
    expect(next.data.map((r) => r.seq)).toEqual([5, 6, 7]);
    const gap = await page(kit, cookie, '?after_seq=5');
    expect(gap.data.map((r) => r.seq)).toEqual([7, 6]);
    expect(gap.applied.filters).toEqual({ after_seq: 5 });
  });

  it('rejects a cursor used with the other dir', async () => {
    const { kit, cookie } = await seeded();
    const first = await page(kit, cookie, '?limit=3');
    const res = await kit.request('GET', `/api/v1/logs?dir=asc&cursor=${first.page.next_cursor}`, {
      cookie,
    });
    expect(res.status).toBe(400);
  });

  it('serializes records with null or ill-typed reserved keys instead of failing the page', async () => {
    const { kit, cookie } = await seeded();
    kit.logs.entries.push({
      seq: 8,
      record: {
        ts: NOW + 8,
        level: 'info',
        msg: 'request completed',
        module: 'http.access',
        principal: null,
        request_id: null,
        transport: 'carrier-pigeon',
        err: 'plain string',
        bytes: null,
      },
    });
    const body = await page(kit, cookie, '?limit=1');
    expect(body.data[0]).toEqual({
      seq: 8,
      ts: NOW + 8,
      level: 'info',
      msg: 'request completed',
      module: 'http.access',
      bytes: null,
      fields: { transport: 'carrier-pigeon', err: 'plain string' },
    });
  });
});

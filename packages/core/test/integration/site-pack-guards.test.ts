/// <reference lib="dom" />
/** @module test/integration/site-pack-guards.test — site-pack network enforcement on a real template host (spec 13 §3.8, §9.3, §17 T3a acceptance): a LinkedIn-shaped pack on the fixture site blocks a `GET` logout load, a form `POST`, a `fetch` and a `sendBeacon` logout with `site_guard_hits` rows; a write under `confirm` is held as a `security_intercept` until approved, aborted on deny and at its deadline, while the session's next tool answers `SITE_OPERATOR_PENDING`; a second write while one is held is aborted; under stdio `confirm` blocks; and the redirect `/go → 302 /m/logout` reaches the site unrouted, as §3.8 documents. */

import { afterEach, describe, expect, it } from 'bun:test';
import { textOf } from '../helpers/fake-transport.ts';
import { guarded, SITE, stopGuarded, until } from './site-pack-guards-fixture.ts';
import { HEADED } from './template-fixture.ts';

afterEach(stopGuarded);

describe(`site-pack network guards (stealth off${HEADED ? ', headed' : ''})`, () => {
  it('blocks a GET logout load, a form POST, a fetch and a beacon logout, each with a hit row', async () => {
    const g = await guarded();
    const logoutHits = () => g.hits().filter((h) => h.guard_id === 'logout');

    await expect(g.page.goto(g.w.sites.url(SITE, '/m/logout'))).rejects.toThrow();
    await until(() => logoutHits().length === 1);
    // The aborted load commits an error page; wait for it before the next navigation.
    await until(() => g.page.url().startsWith('chrome-error://'));

    await g.page.goto(g.w.sites.url(SITE, '/feed'));
    await g.page.click('#logout-post');
    await until(() => logoutHits().length === 2);
    // The aborted POST commits an error page; wait for it before the next navigation.
    await until(() => g.page.url().startsWith('chrome-error://'));

    await g.page.goto(g.w.sites.url(SITE, '/feed'));
    await g.page.click('#logout-fetch');
    await until(() => logoutHits().length === 3);
    await g.page.click('#logout-beacon');
    await until(() => logoutHits().length === 4);

    expect(g.seen('/m/logout')).toBe(0);
    expect(logoutHits().map((h) => [h.method, h.action])).toEqual([
      ['GET', 'block'],
      ['POST', 'block'],
      ['POST', 'block'],
      ['POST', 'block'],
    ]);
    expect(logoutHits()[0]).toMatchObject({
      session_id: g.sessionId,
      template_id: g.w.template.templateId,
      pack_id: SITE,
      guard_kind: 'logout',
      source: 'request',
      url: `https://${SITE}/m/logout`,
    });
  });

  it('the redirect /go → 302 /m/logout reaches the site unrouted (spec 13 §3.8, pinned)', async () => {
    const g = await guarded();
    await g.page.goto(g.w.sites.url(SITE, '/go'));
    expect(g.seen('/go', 'GET')).toBe(1);
    expect(g.seen('/m/logout', 'GET')).toBe(1);
    expect(g.hits()).toEqual([]);
  });

  it('holds a confirm write until approved; meanwhile the session answers SITE_OPERATOR_PENDING', async () => {
    const g = await guarded();
    await g.page.click('#invite');
    await until(() => g.broker.listOpen('security_intercept').length === 1);
    const request = g.broker.listOpen('security_intercept')[0];
    if (request === undefined) throw new Error('no request');
    expect(request).toMatchObject({
      sessionId: g.sessionId,
      templateId: g.w.template.templateId,
      options: { reason: 'write_confirm', guard: { id: 'invite', kind: 'write' }, method: 'POST' },
    });
    expect(g.seen('/api/invite')).toBe(0);

    const held = await g.w.harness.call('snapshot', { session_id: g.sessionId });
    expect(held.isError).toBe(true);
    expect(textOf(held)).toContain('SITE_OPERATOR_PENDING');
    expect(textOf(held)).toContain(request.requestId);
    const waiting = g.w.harness.callJson<{ status: string }>('get_attention_result', {
      request_id: request.requestId,
    });

    await g.broker.resolve(request.requestId, { status: 'resolved' }, 'admin');
    expect((await waiting).status).toBe('resolved');
    await until(() => g.seen('/api/invite', 'POST') === 1);
    await until(() => g.hits().some((h) => h.guard_id === 'invite'));
    expect(g.hits().find((h) => h.guard_id === 'invite')).toMatchObject({
      action: 'confirm',
      outcome: 'approved',
      decided_by: 'admin',
      request_id: request.requestId,
    });
    expect(g.intercepts.holdOf(g.sessionId)).toBeNull();
    const after = await g.w.harness.call('snapshot', { session_id: g.sessionId });
    expect(after.isError).not.toBe(true);
  });

  it('a denied write is aborted; a second write while one is held is aborted at once', async () => {
    const g = await guarded();
    await g.page.click('#invite-twice');
    await until(() => g.hits().some((h) => h.outcome === 'cancelled'));
    const open = g.broker.listOpen('security_intercept');
    expect(open).toHaveLength(1);
    const id = open[0]?.requestId ?? '';
    expect(g.hits().find((h) => h.outcome === 'cancelled')).toMatchObject({
      guard_id: 'invite',
      action: 'confirm',
      request_id: id,
    });
    await g.broker.resolve(id, { status: 'rejected' }, 'admin');
    await until(() => g.hits().some((h) => h.outcome === 'denied'));
    expect(g.seen('/api/invite')).toBe(0);
  });

  it('a write is aborted at its deadline', async () => {
    const g = await guarded({ timeoutMs: 1_500 });
    await g.page.click('#invite');
    await until(() => g.hits().some((h) => h.outcome === 'timeout'), 15_000);
    expect(g.seen('/api/invite')).toBe(0);
    expect(g.intercepts.holdOf(g.sessionId)).toBeNull();
  });

  it('under transport=stdio a confirm write is blocked: nobody can answer', async () => {
    const g = await guarded({ transport: 'stdio' });
    await g.page.click('#invite');
    await until(() => g.hits().some((h) => h.guard_id === 'invite'));
    expect(g.hits().find((h) => h.guard_id === 'invite')).toMatchObject({
      action: 'block',
      outcome: null,
    });
    expect(g.broker.listOpen()).toHaveLength(0);
    expect(g.seen('/api/invite')).toBe(0);
  });
});

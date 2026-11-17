/// <reference lib="dom" />
/** @module test/integration/site-pack-guards.test — site-pack network enforcement on a real template host (spec 13 §3.8, §9.3, §17 T3a acceptance): a LinkedIn-shaped pack on the fixture site blocks a `GET` logout load, a form `POST`, a `fetch` and a `sendBeacon` logout with `site_guard_hits` rows; a write under `confirm` is held as a `security_intercept` until approved, aborted on deny and at its deadline, while the session's next tool answers `SITE_OPERATOR_PENDING`; a second write while one is held is aborted; under stdio `confirm` blocks; and the redirect `/go → 302 /m/logout` reaches the site unrouted, as §3.8 documents. */

import { afterEach, describe, expect, it } from 'bun:test';
import { SiteGuardHitRow } from '@browserhive/contracts/http';
import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import type { Page } from 'patchright';
import { SecurityInterceptService } from '../../src/app/site-packs/security-intercepts.ts';
import { TemplateWritePolicies } from '../../src/app/site-packs/write-policies.ts';
import type { OperatorRequestBroker } from '../../src/domain/operator-requests/broker.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { SiteGuardHitsWriter } from '../../src/infra/site-packs/guard-hits-writer.ts';
import { GuardRuleCatalog } from '../../src/infra/site-packs/guard-rules.ts';
import { templateRequestGuard } from '../../src/infra/site-packs/template-guard.ts';
import type { SecurityIntercepts } from '../../src/ports/security-intercepts.ts';
import type { EffectivePack, SitePackLookup } from '../../src/ports/site-packs.ts';
import { textOf } from '../helpers/fake-transport.ts';
import { HEADED } from './template-fixture.ts';
import { type TemplateMcp, templateMcp } from './template-mcp-fixture.ts';

const SITE = 'site-a.test';

/** A LinkedIn-shaped pack on the fixture site (spec 13 §14). */
function fixturePack(): EffectivePack {
  const input: SitePackV1Input = {
    schema: 1,
    id: SITE,
    version: 1,
    min_client: '0.3.0',
    title: 'Site A',
    domains: [SITE],
    sign_in: { url: { host: SITE, path: '/login' }, human_only: false },
    signed_in: {
      probe: { host: SITE, path: '/feed' },
      kind: 'redirect',
      signed_out_redirects: [`${SITE}/login*`],
    },
    guards: [
      { id: 'logout', kind: 'logout', match: { url: `${SITE}/m/logout` }, action: 'block' },
      {
        id: 'invite',
        kind: 'write',
        match: { url: `${SITE}/api/invite*`, methods: ['POST'] },
        action: 'write_policy',
      },
    ],
    write_policy: { default: 'confirm', stance: 'prohibited' },
  };
  const pack = SitePackV1.parse(input);
  return {
    packId: pack.id,
    pack,
    version: 1,
    sha256: 'f'.repeat(64),
    source: 'local',
    localOverride: false,
  };
}

interface Guarded {
  readonly w: TemplateMcp;
  readonly broker: OperatorRequestBroker;
  readonly intercepts: SecurityIntercepts;
  readonly sessionId: string;
  readonly page: Page;
  hits(): SiteGuardHitRow[];
  seen(path: string, method?: string): number;
}

let world: TemplateMcp | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

async function guarded(
  options: { transport?: 'http' | 'stdio'; timeoutMs?: number } = {},
): Promise<Guarded> {
  const ref: { current: SecurityIntercepts | null } = { current: null };
  const w = await templateMcp('off', {
    sites: [{ siteId: SITE, packId: SITE }],
    siteHolds: { holdOf: (id) => ref.current?.holdOf(id) ?? null },
    ...(options.transport !== undefined && { transport: options.transport }),
  });
  world = w;
  const pack = fixturePack();
  const lookup: SitePackLookup = {
    effectiveFor: (host) => (host === SITE || host.endsWith(`.${SITE}`) ? pack : null),
    effectiveById: (id) => (id === SITE ? pack : null),
    generation: 1,
  };
  const logger = createCollectingLogger();
  const { harness } = w;
  const sessions = harness.services.sessions;
  const repos = harness.templates.repos;
  const catalog = new GuardRuleCatalog();
  const hits = new SiteGuardHitsWriter({
    describe: catalog.describe,
    bus: harness.bus,
    ids: harness.services.ids,
    warn: (id, warning) => {
      const session = sessions.peek(id);
      if (session !== undefined) sessions.warn(session, warning);
    },
    logger,
  });
  const intercepts = new SecurityInterceptService({
    broker: harness.attentionBroker,
    sessions,
    templates: repos.templates,
    templateSites: repos.templateSites,
    health: null,
    describe: catalog.describe,
    hits,
    bus: harness.bus,
    clock: harness.services.clock,
    logger,
    config: {
      transport: options.transport ?? 'http',
      attentionTimeoutMs: options.timeoutMs ?? 120_000,
      minAttentionWaitMs: 0,
    },
  });
  ref.current = intercepts;
  w.driver.setTemplateRequestGuard(
    templateRequestGuard({
      lookup,
      overrides: new TemplateWritePolicies({
        sites: repos.templateSites,
        bus: harness.bus,
        logger,
      }),
      catalog,
      hits,
      confirmer: intercepts.confirmer,
      clock: harness.services.clock,
      logger,
    }),
  );
  const launched = await harness.callJson<{ session_id: string }>('launch_session', {
    slug: 'guards',
    template: w.template.name,
  });
  const page = sessions.peek(launched.session_id)?.view?.page;
  if (page === undefined) throw new Error('no page');
  await page.goto(w.sites.url(SITE, '/feed'));
  return {
    w,
    broker: harness.attentionBroker,
    intercepts,
    sessionId: launched.session_id,
    page,
    hits: () =>
      harness.bus.published
        .filter((p) => p.name === 'site_pack.guard_hit')
        .map((p) => SiteGuardHitRow.parse((p.payload as { row: unknown }).row)),
    seen: (path, method) =>
      w.sites.requests.filter(
        (r) => r.path.startsWith(path) && (method === undefined || r.method === method),
      ).length,
  };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

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

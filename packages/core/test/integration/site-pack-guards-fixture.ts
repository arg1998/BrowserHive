/** @module test/integration/site-pack-guards-fixture — a template session on the fixture site `site-a.test` with a LinkedIn-shaped pack and WP-E1's network enforcement armed (rule source, hit writer, security intercepts, the dispatcher's tool hold), for the guard suites. */

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
import { type TemplateMcp, templateMcp } from './template-mcp-fixture.ts';

/** The guarded fixture site. */
export const SITE = 'site-a.test';

/** A LinkedIn-shaped pack on the fixture site (spec 13 §14). */
export function guardPack(): EffectivePack {
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

/** One test's guarded world. */
export interface Guarded {
  readonly w: TemplateMcp;
  readonly broker: OperatorRequestBroker;
  readonly intercepts: SecurityIntercepts;
  readonly sessionId: string;
  readonly page: Page;
  hits(): SiteGuardHitRow[];
  seen(path: string, method?: string): number;
}

let world: TemplateMcp | null = null;

/** Stops the current world (each suite's `afterEach`). */
export async function stopGuarded(): Promise<void> {
  await world?.stop();
  world = null;
}

/** A template session on the fixture site with the network enforcement armed. */
export async function guarded(
  options: { transport?: 'http' | 'stdio'; timeoutMs?: number } = {},
): Promise<Guarded> {
  const ref: { current: SecurityIntercepts | null } = { current: null };
  const w = await templateMcp('off', {
    sites: [{ siteId: SITE, packId: SITE }],
    siteHolds: { holdOf: (id) => ref.current?.holdOf(id) ?? null },
    ...(options.transport !== undefined && { transport: options.transport }),
  });
  world = w;
  const pack = guardPack();
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

/** Polls `check` until true. */
export async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

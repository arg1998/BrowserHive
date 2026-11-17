/** @module composition/site-pack-enforcement — the network half of site-pack enforcement (spec 13 §9.3, §9.5; PR T3a WP-E1): the guard-hit writer, the security intercepts over the operator-request broker, the template sites' write-policy overrides, and the request guard every template host's chain carries. Under `templates=false` or `sitePacks=false` nothing is built and hosts carry no guard. */

import type { ServerConfig } from '@browserhive/contracts/config';
import type { SqliteUnitOfWork } from '@browserhive/core/persistence';
import type { SitePackLookup } from '@browserhive/core/ports/site-packs';
import type { Clock, DomainEvents, EventBus, IdGenerator, Logger } from '@browserhive/core/runtime';
import {
  GuardRuleCatalog,
  NO_SITE_PACKS,
  type OperatorRequestBroker,
  type PlaywrightBrowserDriver,
  SecurityInterceptService,
  type SessionService,
  SiteGuardHitsWriter,
  type TemplateHealthParts,
  TemplateWritePolicies,
  templateRequestGuard,
  WritePacer,
} from '@browserhive/core/server';

/** Inputs of {@link buildSitePackEnforcement}. */
export interface SitePackEnforcementInput {
  readonly config: Readonly<ServerConfig>;
  readonly transport: 'http' | 'stdio';
  readonly driver: PlaywrightBrowserDriver;
  readonly broker: OperatorRequestBroker;
  readonly sessions: SessionService;
  readonly uow: SqliteUnitOfWork;
  /** Template health (`template.challenged` from site checks); `null` under `templates=false`. */
  readonly health: TemplateHealthParts | null;
  /** The registry's read side (WP-R); `null` until it is wired: only `DEFAULT_GUARDS` apply. */
  readonly lookup: SitePackLookup | null;
  readonly bus: EventBus<DomainEvents>;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** What the enforcement hands the tool layer (WP-E2) and the dispatcher. */
export interface SitePackEnforcement {
  /** The `SecurityIntercepts` port (the dispatcher's `siteHolds`, the tool path's approvals, challenges). */
  readonly intercepts: SecurityInterceptService;
  /** The `site_guard_hits` writer (the tool layer writes its element and navigation hits with it). */
  readonly hits: SiteGuardHitsWriter;
  readonly catalog: GuardRuleCatalog;
  /** The template sites' write-policy overrides (the tool layer's element and navigation guards). */
  readonly policies: TemplateWritePolicies;
  readonly stop: () => void;
}

/** Builds the enforcement and arms every template host start with the request guard. */
export function buildSitePackEnforcement(
  input: SitePackEnforcementInput,
): SitePackEnforcement | null {
  const { config } = input;
  if (!config.templates || !config.sitePacks) return null;
  const lookup = input.lookup ?? NO_SITE_PACKS;
  const repos = input.uow.repos;
  const catalog = new GuardRuleCatalog();
  const hits = new SiteGuardHitsWriter({
    describe: catalog.describe,
    bus: input.bus,
    ids: input.ids,
    warn: (sessionId, warning) => {
      const session = input.sessions.peek(sessionId);
      if (session !== undefined) input.sessions.warn(session, warning);
    },
    logger: input.logger,
  });
  const intercepts = new SecurityInterceptService({
    broker: input.broker,
    sessions: input.sessions,
    templates: repos.templates,
    templateSites: repos.templateSites,
    health: input.health?.health ?? null,
    describe: catalog.describe,
    requestGuardOf: (packId, guardId) =>
      lookup.effectiveById(packId)?.pack.element_guards.find((g) => g.id === guardId)
        ?.request_guard ?? null,
    packTitle: (packId) => lookup.effectiveById(packId)?.pack.title ?? null,
    hits,
    bus: input.bus,
    clock: input.clock,
    logger: input.logger,
    config: {
      transport: input.transport,
      attentionTimeoutMs: config.attentionTimeout,
      minAttentionWaitMs: config.minAttentionWait,
    },
  });
  const policies = new TemplateWritePolicies({
    sites: repos.templateSites,
    bus: input.bus,
    logger: input.logger,
  });
  input.driver.setTemplateRequestGuard(
    templateRequestGuard({
      lookup,
      overrides: policies,
      catalog,
      hits,
      confirmer: intercepts.confirmer,
      // `pace-writes` with `ramp-up` (spec 13 §9.4; T3b WP-N).
      pacer: new WritePacer({
        describe: catalog.describe,
        lookup,
        templates: repos.templates,
        sites: repos.templateSites,
        clock: input.clock,
        random: Math.random,
        logger: input.logger,
      }),
      clock: input.clock,
      logger: input.logger,
      urlQueryAllowlist: config.urlQueryAllowlist,
    }),
  );
  return {
    intercepts,
    hits,
    catalog,
    policies,
    stop: () => {
      input.driver.setTemplateRequestGuard(null);
      intercepts.stop();
      policies.stop();
    },
  };
}

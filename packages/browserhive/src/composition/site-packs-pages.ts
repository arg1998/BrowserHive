/** @module composition/site-packs-pages — site pack enforcement on pages and tools (spec 13 §9.3 the tool layer, §9.5 challenges and `stop`, §8.1 the pack prober; T3a WP-E2): the tool gate, the challenge watch on template hosts' pages, the stops, the tool-path hit rows and the prober selector. The registry's lookup and the security intercepts are attached later (`attach`), so this wires before them. */

import type { SecurityIntercepts } from '@browserhive/core/ports/security-intercepts';
import type { SitePackLookup } from '@browserhive/core/ports/site-packs';
import type { TemplatePageWatcher } from '@browserhive/core/ports/template-host';
import type {
  Clock,
  DomainEvents,
  EventBus,
  IdGenerator,
  Logger,
  Repositories,
  WriteQueue,
} from '@browserhive/core/runtime';
import {
  AgentNavigations,
  type BuiltinGuard,
  ChallengeOutcomes,
  ChallengeWatch,
  maintenanceProbePages,
  PackProber,
  type ProberSelector,
  packProberSelector,
  type SessionService,
  SiteToolGate,
  type TemplateHealthParts,
  type TemplateHostSupervisor,
  TemplateSiteStops,
  ToolGuardHits,
} from '@browserhive/core/server';

/** Inputs of {@link buildSitePackPages}. */
export interface SitePackPagesInput {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'operatorActions'>;
  /** The recorder's write queue (`site_guard_hits` rows of the tool path). */
  readonly queue: Pick<WriteQueue, 'enqueue'>;
  readonly sessions: SessionService;
  readonly transport: 'http' | 'stdio';
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly logger: Logger;
}

/** What the composition keeps and hands on. */
export interface SitePackPagesParts {
  readonly gate: SiteToolGate;
  readonly stops: TemplateSiteStops;
  readonly navigations: AgentNavigations;
  /** The watcher every template host hands its pages to (`attachTemplatePageWatcher`). */
  readonly pageWatcher: TemplatePageWatcher;
  /** The prober selector `wireTemplateHealth` takes, over the supervisor's maintenance sessions. */
  probers(supervisor: TemplateHostSupervisor, fallback: ProberSelector): ProberSelector;
  /**
   * Attaches what is built later: the registry (WP-R), the security intercepts (WP-E1), the health
   * service (T2) and `DEFAULT_GUARDS`. Each is optional; absent ones keep enforcement to stops and
   * `DEFAULT_CHALLENGES` (health only).
   */
  attach(parts: {
    readonly lookup?: SitePackLookup | null;
    readonly intercepts?: SecurityIntercepts | null;
    readonly health?: TemplateHealthParts['health'] | null;
    /** `DEFAULT_GUARDS` (WP-E1's `domain/site-packs/default-guards.ts`). */
    readonly defaultGuards?: readonly BuiltinGuard[];
  }): void;
  /** Unsubscribes the bus hooks. */
  readonly stop: () => void;
}

/** Builds the page enforcement of site packs. */
export function buildSitePackPages(input: SitePackPagesInput): SitePackPagesParts {
  const { repos, sessions, clock, logger, bus } = input;
  const late: {
    lookup: SitePackLookup | null;
    intercepts: SecurityIntercepts | null;
    health: TemplateHealthParts['health'] | null;
    defaultGuards: readonly BuiltinGuard[];
  } = { lookup: null, intercepts: null, health: null, defaultGuards: [] };
  const lookup = () => late.lookup;
  const navigations = new AgentNavigations(clock);
  const hits = new ToolGuardHits({
    sink: (record) => {
      input.queue.enqueue('site_guard_hits.insert', (r) => r.siteGuardHits.insert(record));
    },
    ids: input.ids,
    clock,
  });
  const stops = new TemplateSiteStops({ repos, ids: input.ids, clock, logger, bus });
  const gate = new SiteToolGate({
    sites: (templateId) => repos.templateSites.list(templateId),
    lookup,
    // Under stdio no operator can answer: `confirm` acts as `block` (spec 13 §9.3).
    intercepts: () => (input.transport === 'stdio' ? null : late.intercepts),
    defaultGuards: () => late.defaultGuards,
    hits,
    navigations,
    pageOf: (session, tabId) => sessions.page(session, tabId),
    clock,
    logger,
  });
  const outcomes = new ChallengeOutcomes({
    modeOf: (sessionId) => sessions.peek(sessionId)?.template?.mode,
    repos,
    health: () => late.health,
    stops,
    intercepts: () => late.intercepts,
    lookup,
    transport: input.transport,
    bus,
    logger,
  });
  const watch = new ChallengeWatch({ lookup, navigations, outcomes, clock, logger });
  const off = bus.subscribe('session.closed', ({ payload }) =>
    navigations.forget(payload.session_id),
  );
  return {
    gate,
    stops,
    navigations,
    pageWatcher: {
      pageAttributed: (templateId, page, sessionId) => watch.watch(templateId, page, sessionId),
    },
    probers(supervisor, fallback) {
      const prober = new PackProber({
        lookup,
        openPage: maintenanceProbePages({
          launchMaintenance: (launch) => supervisor.launchMaintenance(launch),
          close: (sessionId) => sessions.close(sessionId, 'operator'),
        }),
        logger,
      });
      return packProberSelector(prober, lookup, fallback);
    },
    attach(parts) {
      if (parts.lookup !== undefined) late.lookup = parts.lookup;
      if (parts.intercepts !== undefined) late.intercepts = parts.intercepts;
      if (parts.health !== undefined) late.health = parts.health;
      if (parts.defaultGuards !== undefined) late.defaultGuards = parts.defaultGuards;
    },
    stop: off,
  };
}

/** @module composition/site-packs-pages — site pack enforcement on pages and tools (spec 13 §9.3 the tool layer, §9.5 challenges and `stop`, §8.1 the pack prober; T3a WP-E2): the tool gate, the challenge watch on template hosts' pages, the stops and the prober selector. Built before the templates (the prober goes into the health wiring); the network enforcement (WP-E1: intercepts, hit writer, rule catalog, write policies) and the registry's lookup attach once built. */

import type { SitePackLookup } from '@browserhive/core/ports/site-packs';
import type { TemplatePageWatcher } from '@browserhive/core/ports/template-host';
import type {
  Clock,
  DomainEvents,
  EventBus,
  IdGenerator,
  Logger,
  Repositories,
} from '@browserhive/core/runtime';
import {
  AgentNavigations,
  ChallengeOutcomes,
  ChallengeWatch,
  documentGuardResolver,
  maintenanceProbePages,
  NO_SITE_PACKS,
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
import type { SitePackEnforcement } from './site-pack-enforcement.ts';

/** Inputs of {@link buildSitePackPages}. */
export interface SitePackPagesInput {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'operatorActions'>;
  readonly sessions: SessionService;
  readonly transport: 'http' | 'stdio';
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly logger: Logger;
}

/** What is attached once built. */
export interface SitePackPagesAttachment {
  /** WP-E1's network enforcement (`null` under `templates=false` or `sitePacks=false`). */
  readonly enforcement: Pick<
    SitePackEnforcement,
    'intercepts' | 'hits' | 'catalog' | 'policies'
  > | null;
  /** The registry's read side (WP-R); `null` until wired: only the compiled-in defaults apply. */
  readonly lookup: SitePackLookup | null;
  readonly health: TemplateHealthParts['health'] | null;
}

/** What the composition keeps and hands on. */
export interface SitePackPagesParts {
  readonly gate: SiteToolGate;
  readonly stops: TemplateSiteStops;
  /** Agents' own navigations (the before-action strategies' warm-up re-arms them). */
  readonly navigations: AgentNavigations;
  /** The watcher every template host hands its pages to (`attachTemplatePageWatcher`). */
  readonly pageWatcher: TemplatePageWatcher;
  /** The prober selector `wireTemplateHealth` takes, over the supervisor's maintenance sessions. */
  probers(supervisor: TemplateHostSupervisor, fallback: ProberSelector): ProberSelector;
  attach(parts: SitePackPagesAttachment): void;
  /** Unsubscribes the bus hooks. */
  readonly stop: () => void;
}

/** Builds the page enforcement of site packs. */
export function buildSitePackPages(input: SitePackPagesInput): SitePackPagesParts {
  const { repos, sessions, clock, logger, bus } = input;
  let attached: SitePackPagesAttachment = { enforcement: null, lookup: null, health: null };
  let documentGuard: ReturnType<typeof documentGuardResolver> | null = null;
  const lookup = () => attached.lookup;
  const intercepts = () => attached.enforcement?.intercepts ?? null;
  const navigations = new AgentNavigations(clock);
  const stops = new TemplateSiteStops({ repos, ids: input.ids, clock, logger, bus });
  const gate = new SiteToolGate({
    sites: (templateId) => repos.templateSites.list(templateId),
    lookup,
    // Under stdio the intercepts answer `blocked`: `confirm` acts as `block` (spec 13 §9.3).
    intercepts,
    documentGuard: () => documentGuard,
    overrides: () => attached.enforcement?.policies ?? null,
    hits: new ToolGuardHits({ sink: () => attached.enforcement?.hits ?? null, clock }),
    navigations,
    pageOf: (session, tabId) => sessions.page(session, tabId),
    clock,
    logger,
  });
  const outcomes = new ChallengeOutcomes({
    modeOf: (sessionId) => sessions.peek(sessionId)?.template?.mode,
    repos,
    health: () => attached.health,
    stops,
    intercepts,
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
      attached = parts;
      const enforcement = parts.enforcement;
      documentGuard =
        enforcement === null
          ? null
          : documentGuardResolver({
              lookup: parts.lookup ?? NO_SITE_PACKS,
              overrides: enforcement.policies,
              catalog: enforcement.catalog,
              logger,
            });
    },
    stop: off,
  };
}

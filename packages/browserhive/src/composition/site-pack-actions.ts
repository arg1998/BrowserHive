/** @module composition/site-pack-actions — the before-action strategies of site packs (spec 13 §9.4, §9.6; T3b WP-B): `serialize-site`, `human-dwell`, `entry-warmup`, `humanize-input` and `single-focus` around the tools of agents' template sessions. Built with the network enforcement: under `templates=false` or `sitePacks=false` nothing is built and every strategy is inert. */

import type { SitePackLookup } from '@browserhive/core/ports/site-packs';
import type {
  Clock,
  DomainEvents,
  EventBus,
  Logger,
  Repositories,
} from '@browserhive/core/runtime';
import {
  type AgentNavigations,
  CdpPageFocus,
  persistedDwell,
  type SessionService,
  SiteActionStrategies,
  type StrategyState,
} from '@browserhive/core/server';

/** Inputs of {@link buildSiteActions}. */
export interface SiteActionsInput {
  readonly repos: Pick<Repositories, 'templateSites'>;
  readonly sessions: SessionService;
  readonly lookup: SitePackLookup;
  /** The tool gate's record of agents' own navigations (challenge exemption). */
  readonly navigations: AgentNavigations;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly undo: (() => void | Promise<void>)[];
  /** The persisted strategy state (the dwell across a restart, D53); `null`: in memory. */
  readonly state?: StrategyState | null;
}

/** Builds the runner the dispatcher wraps template sessions' tools in. */
export function buildSiteActions(input: SiteActionsInput): SiteActionStrategies {
  const { sessions, logger } = input;
  const strategies = new SiteActionStrategies({
    lookup: () => input.lookup,
    sites: (templateId) => input.repos.templateSites.list(templateId),
    pageOf: (session, tabId) => sessions.page(session, tabId),
    pagesOf: (session) => sessions.pages(session),
    sessions: () => sessions.listAll(),
    focus: new CdpPageFocus(logger),
    navigations: input.navigations,
    clock: input.clock,
    random: Math.random,
    logger,
    ...(input.state != null && {
      dwellMemory: persistedDwell(
        input.state,
        (id) => sessions.peek(id)?.template?.templateId ?? null,
      ),
    }),
  });
  const offClosed = input.bus.subscribe('session.closed', ({ payload }) =>
    strategies.sessionClosed(payload.session_id),
  );
  // A pack that stops selecting `single-focus` gives its pages their focus back.
  const offChanged = input.bus.subscribe('site_pack.changed', () => {
    void strategies.reconcile();
  });
  input.undo.push(() => {
    offClosed();
    offChanged();
  });
  return strategies;
}

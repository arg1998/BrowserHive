/** @module composition/site-pack-strategies — the host-side pack strategies of T3b (spec 13 §9.4; WP-N): `webrtc-policy` (the host spec's switches and the restart when they change), `keep-alive` (the keeper on the health tick, its record of agent loads) and `device-bound-session` (the host response watch). Built with the site-pack layer, before the templates; under `templates=false` or `sitePacks=false` nothing is built, so every one of them is inert. */

import type { ServerConfig } from '@browserhive/contracts/config';
import type {
  Repositories,
  TemplateRecord,
  UnitOfWork,
} from '@browserhive/core/ports/persistence/index';
import type { TemplatePageWatcher } from '@browserhive/core/ports/template-host';
import {
  type Clock,
  type DomainEvents,
  type EventBus,
  type Logger,
  serializeError,
} from '@browserhive/core/runtime';
import {
  AgentSiteVisits,
  DeviceBindingWatch,
  HostFlagsWatch,
  maintenanceProbePages,
  PackProber,
  type SessionService,
  SiteKeeper,
  type SitePackRegistry,
  type StrategyState,
  type TemplateHealthParts,
  type TemplateHostOperations,
  type TemplateHostSupervisor,
} from '@browserhive/core/server';

/** How often the keeper looks for due sites (spec 13 §9.4: intervals are hours). */
export const KEEPER_TICK_MS = 60_000;

/** Inputs of {@link buildSiteStrategies}. */
export interface SiteStrategiesInput {
  readonly config: Readonly<ServerConfig>;
  readonly registry: SitePackRegistry;
  readonly uow: UnitOfWork;
  readonly repos: Pick<Repositories, 'templates' | 'templateSites'>;
  readonly sessions: SessionService;
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Uniform in `[0, 1)` (test seam). */
  readonly random?: () => number;
  /** The persisted strategy state, read back at boot (D53); `null` or absent: in memory only. */
  readonly state?: StrategyState | null;
}

/** What the templates attach once their supervisor, operations and health exist. */
export interface SiteStrategyAttachment {
  readonly supervisor: TemplateHostSupervisor;
  readonly ops: TemplateHostOperations;
  readonly health: TemplateHealthParts | null;
  /** `template.changed` (the device-bound badge). */
  readonly changed: (templateId: string) => void;
  readonly repeat: (fn: () => void, ms: number) => () => void;
}

/** The host strategies. */
export interface SiteStrategies {
  /** The host spec's `hostFlags` (`webrtc-policy`). */
  readonly hostFlags: (template: TemplateRecord) => Promise<readonly string[]>;
  /** Joins the site-pack page watcher: agent loads (keeper) and responses (device binding). */
  readonly pageWatcher: TemplatePageWatcher;
  attach(parts: SiteStrategyAttachment): void;
  /** The persisted strategy state the admission, pacer and dwell use; `null`: in memory only. */
  readonly state: StrategyState | null;
  readonly stop: () => void;
}

/** Builds the host strategies; `null` when templates or site packs are off. */
export function buildSiteStrategies(input: SiteStrategiesInput): SiteStrategies | null {
  const { config, registry, logger } = input;
  if (!config.templates || !config.sitePacks) return null;
  const lookup = () => registry;
  const attached: { parts: SiteStrategyAttachment | null } = { parts: null };
  const flags = new HostFlagsWatch({
    sites: input.repos.templateSites,
    lookup,
    running: (id) => attached.parts?.supervisor.runningHost(id) != null,
    restart: async (id) => {
      const parts = attached.parts;
      const template = await input.repos.templates.get(id);
      if (parts !== null && template !== null) await parts.ops.restartHost(template);
    },
    bus: input.bus,
    logger,
  });
  const visits = new AgentSiteVisits({
    isAgent: (id) => input.sessions.peek(id)?.template?.mode === 'live',
    clock: input.clock,
  });
  const binding = new DeviceBindingWatch({
    lookup,
    uow: input.uow,
    changed: (id) => attached.parts?.changed(id),
    bus: input.bus,
    logger,
  });
  const offRemoved = input.bus.subscribe('template.removed', ({ payload }) =>
    visits.forget(payload.template_id),
  );
  const stops: (() => void)[] = [() => flags.stop(), () => binding.stop(), offRemoved];
  return {
    state: input.state ?? null,
    hostFlags: (template) => flags.hostFlags(template),
    pageWatcher: {
      pageAttributed: (templateId, page, sessionId) =>
        visits.pageAttributed(templateId, page, sessionId),
      responseReceived: (templateId, response) => binding.responseReceived(templateId, response),
    },
    attach(parts) {
      attached.parts = parts;
      const health = parts.health?.health;
      if (health === undefined) return;
      const { supervisor, ops } = parts;
      const prober = new PackProber({
        lookup,
        openPage: maintenanceProbePages({
          launchMaintenance: (launch) => supervisor.launchMaintenance(launch),
          close: (sessionId) => input.sessions.close(sessionId, 'operator'),
        }),
        logger,
      });
      const keeper = new SiteKeeper({
        repos: input.repos,
        lookup,
        visits,
        hosts: {
          runningHost: (id) => supervisor.runningHost(id),
          withHost: (template, fn) => ops.withHost(template, fn),
          slotFree: () => {
            const cap = input.sessions.capacity();
            return cap === null || input.sessions.occupiedSlots() < cap;
          },
        },
        visit: (ctx, path) => prober.visit(ctx, path),
        record: (template, siteId, verdict) => health.record(template, siteId, verdict, 'schedule'),
        clock: input.clock,
        random: input.random ?? Math.random,
        logger,
      });
      stops.push(parts.repeat(() => void keeper.tick(), KEEPER_TICK_MS));
    },
    stop: () => {
      for (const stop of stops.splice(0)) stop();
    },
  };
}

/** One watcher over several, each called in order; one that throws is logged and skipped. */
export function joinPageWatchers(
  logger: Logger,
  ...watchers: readonly (TemplatePageWatcher | null | undefined)[]
): TemplatePageWatcher {
  const present = watchers.filter((w): w is TemplatePageWatcher => w != null);
  const responders = present.filter((w) => w.responseReceived !== undefined);
  const each = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      logger.warn('page watcher threw', { err: serializeError(err) });
    }
  };
  return {
    pageAttributed: (templateId, page, sessionId) => {
      for (const w of present) each(() => w.pageAttributed(templateId, page, sessionId));
    },
    ...(responders.length > 0 && {
      responseReceived: (templateId, response) => {
        for (const w of responders) each(() => w.responseReceived?.(templateId, response));
      },
    }),
  };
}

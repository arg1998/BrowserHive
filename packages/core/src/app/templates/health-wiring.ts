/** @module app/templates/health-wiring — assembles health and re-login (spec 13 §8, PR T2) over the host supervisor: probes, the schedule, the pre-launch check, re-login, the vault link, the routes' facade, and the hooks between them (a browser start probes, a sign-out tries the vault, an attention request that resolves probes). */

import type { Clock } from '../../ports/clock.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { Repositories } from '../../ports/persistence/index.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { SessionService } from '../sessions/session-service.ts';
import type { VaultAdmin } from '../vault/vault-admin.ts';
import { TemplateHealthFacade } from './health-facade.ts';
import { HealthScheduler } from './health-scheduler.ts';
import type { TemplateHostOperations } from './host-operations.ts';
import type { TemplateHostSupervisor } from './host-supervisor.ts';
import { ReloginLinks } from './relogin-link.ts';
import type { ReloginVault } from './relogin-vault.ts';
import { TemplateHealthService } from './template-health.ts';
import { PrelaunchCheck } from './template-prelaunch.ts';
import { TemplateReloginService } from './template-relogin.ts';
import type { TemplateService } from './template-service.ts';
import type { TemplateStateService } from './template-state.ts';

/** Inputs of {@link wireTemplateHealth}. */
export interface TemplateHealthWiring {
  readonly repos: Pick<
    Repositories,
    'templates' | 'templateSites' | 'templateProbes' | 'operatorActions'
  >;
  readonly supervisor: TemplateHostSupervisor;
  readonly ops: TemplateHostOperations;
  readonly sessions: SessionService;
  readonly service: TemplateService;
  readonly state: TemplateStateService;
  /** The vault (`fill` and the bindings' admin); absent under `vault=off`. */
  readonly vault?: ReloginVault & { readonly admin: Pick<VaultAdmin, 'getBinding' | 'putBinding'> };
  readonly bus: EventBus<DomainEvents>;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The machine sign-in windows open on (`os.hostname()`). */
  readonly machine: string;
  /** A headed browser can open a window on this machine (re-login falls back to the live view). */
  readonly displayAvailable?: () => boolean;
  readonly random?: () => number;
  /** `template.changed`. */
  readonly changed: (templateId: string) => void;
}

/** What the composition keeps. */
export interface TemplateHealthParts {
  readonly health: TemplateHealthService;
  readonly scheduler: HealthScheduler;
  readonly relogin: TemplateReloginService;
  readonly facade: TemplateHealthFacade;
  /** Unsubscribes the bus hooks. */
  readonly stop: () => void;
}

/** Builds the T2 services and connects them. */
export function wireTemplateHealth(input: TemplateHealthWiring): TemplateHealthParts {
  const { supervisor, ops, repos, clock, logger, bus } = input;
  const vault = input.vault?.configured === true ? input.vault : undefined;
  const health = new TemplateHealthService({
    repos,
    hosts: {
      runningHost: (id) => supervisor.runningHost(id),
      withHost: (template, fn) => ops.withHost(template, fn),
      storedJar: async (id) => {
        try {
          return (await input.state.read(id, 'latest')).cookies;
        } catch {
          return null;
        }
      },
      slotFree: () => {
        const cap = input.sessions.capacity();
        return cap === null || input.sessions.occupiedSlots() < cap;
      },
    },
    clock,
    logger,
    bus,
    changed: input.changed,
    machine: input.machine,
  });
  const scheduler = new HealthScheduler({
    repos,
    health,
    clock,
    random: input.random ?? Math.random,
    logger,
  });
  const prelaunch = new PrelaunchCheck({ repos, health, clock });
  const relogin = new TemplateReloginService({
    repos,
    supervisor,
    ops,
    sessions: input.sessions,
    health,
    state: input.state,
    ...(vault !== undefined && { vault }),
    ids: input.ids,
    clock,
    logger,
    bus,
    machine: input.machine,
    changed: input.changed,
    ...(input.displayAvailable !== undefined && { displayAvailable: input.displayAvailable }),
  });
  const links = new ReloginLinks({
    repos,
    ...(vault !== undefined && { admin: vault.admin }),
    ids: input.ids,
    clock,
    bus,
    changed: input.changed,
  });
  const facade = new TemplateHealthFacade({ repos, health, relogin, links, ids: input.ids, clock });
  supervisor.attachHealth({
    prelaunch: (template, signal) => prelaunch.check(template, signal),
    hostStarted: (id) => scheduler.hostStarted(id),
  });
  health.attach({ signedOut: (template, site) => relogin.signedOut(template, site) });
  input.service.attach({
    reloginOf: (id) => relogin.view(id),
    closeSession: (id) => input.sessions.close(id, 'operator'),
    machine: input.machine,
  });
  // An attention request of a template's session resolved: the operator may have signed in (§8.3).
  const off = bus.subscribe('attention.resolved', (event) => {
    const template = input.sessions.peek(event.payload.request.session_id)?.template;
    if (template?.mode === 'live') scheduler.attentionResolved(template.templateId);
  });
  return { health, scheduler, relogin, facade, stop: off };
}

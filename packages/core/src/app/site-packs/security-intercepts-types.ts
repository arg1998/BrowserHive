/** @module app/site-packs/security-intercepts-types — the collaborators and shared context of the security-intercept service and its write and site-check halves. */

import type { OperatorRequestBroker } from '../../domain/operator-requests/broker.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRepository, TemplateSiteRepository } from '../../ports/persistence/index.ts';
import type { GuardRuleDescriber, SiteGuardHitSink } from '../../ports/site-guards.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { SessionService } from '../sessions/session-service.ts';
import type { TemplateHealthService } from '../templates/template-health.ts';
import type { PassBook } from './security-intercepts-passes.ts';
import type { InterceptBook } from './security-intercepts-state.ts';

/** The config keys the intercepts read (already in ms). */
export interface SecurityInterceptsConfig {
  readonly transport: 'http' | 'stdio';
  /** `attentionTimeout`: a request's deadline. */
  readonly attentionTimeoutMs: number;
  /** `minAttentionWait`: the deadline's floor (D-15). */
  readonly minAttentionWaitMs: number;
}

/** Collaborators of the security-intercept service. */
export interface SecurityInterceptsDeps {
  readonly broker: Pick<OperatorRequestBroker, 'open' | 'cancel'>;
  readonly sessions: Pick<SessionService, 'peek' | 'warn'>;
  readonly templates: Pick<TemplateRepository, 'get'>;
  readonly templateSites: Pick<TemplateSiteRepository, 'list' | 'upsert'>;
  /** Health of template sites (`template.challenged`); `null` under `templates=false`. */
  readonly health: Pick<TemplateHealthService, 'record' | 'probe'> | null;
  readonly describe: GuardRuleDescriber;
  /** The `request_guard` an element guard names, so a used pass also covers the write it sends. */
  readonly requestGuardOf?: (packId: string, elementGuardId: string) => string | null;
  /** The title of a pack in force ("LinkedIn"), for the tool path's requests. */
  readonly packTitle?: (packId: string) => string | null;
  readonly hits: SiteGuardHitSink;
  readonly bus: Pick<EventBus<DomainEvents>, 'publish' | 'subscribe'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: SecurityInterceptsConfig;
}

/** What the halves share. */
export interface InterceptContext {
  readonly deps: SecurityInterceptsDeps;
  readonly book: InterceptBook;
  readonly passes: PassBook;
  readonly log: Logger;
}

/** A request's deadline: `max(attentionTimeout, minAttentionWait)` (D-15). */
export function interceptTimeoutMs(config: SecurityInterceptsConfig): number {
  return Math.max(config.attentionTimeoutMs, config.minAttentionWaitMs);
}

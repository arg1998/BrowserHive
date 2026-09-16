/** @module app/sessions/session-publisher — publishes every `session.*` event and warning log line on behalf of the service. */

import type { ClosedReason } from '@browserhive/contracts/enums';
import { SessionId } from '@browserhive/contracts/ids';
import type { Session } from '../../domain/session/session.ts';
import type { SessionWarning } from '../../domain/session/warnings.ts';
import type { ProxySpec } from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { toSessionPatch, toSessionRecord, toSessionSummary } from './metadata.ts';

/** Dependencies of {@link SessionPublisher}. */
export interface SessionPublisherDeps {
  readonly bus: EventBus<DomainEvents>;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** The single place `session.*` events are shaped; every mutation of the service goes through here. */
export class SessionPublisher {
  constructor(private readonly deps: SessionPublisherDeps) {}

  /** `session.opened` with the DB record (reserved state). */
  opened(session: Session): void {
    this.deps.bus.publish('session.opened', {
      type: 'session.opened',
      session: toSessionSummary(session, this.deps.clock.now()),
      record: toSessionRecord(session),
    });
  }

  /** `session.updated` with the current summary and the mutable-column patch. */
  updated(session: Session): void {
    this.deps.bus.publish('session.updated', {
      type: 'session.updated',
      session: toSessionSummary(session, this.deps.clock.now()),
      patch: toSessionPatch(session),
    });
  }

  /** Appends the warning, logs it at `warn`, broadcasts `session.warning`. */
  warn(session: Session, warning: SessionWarning): void {
    session.addWarning(warning);
    this.deps.logger.warn('session warning', {
      sessionId: session.id,
      code: warning.code,
      detail: warning.message,
      ...(warning.details !== undefined && { details: warning.details }),
    });
    this.deps.bus.publish('session.warning', {
      type: 'session.warning',
      session_id: SessionId.parse(session.id),
      code: warning.code,
      message: warning.message,
      ...(warning.details !== undefined && { details: warning.details }),
    });
  }

  /** `session.proxy_assigned` (D-13). */
  proxyAssigned(session: Session, proxy: ProxySpec | null): void {
    this.deps.bus.publish('session.proxy_assigned', {
      type: 'session.proxy_assigned',
      session_id: session.id,
      proxy_label: proxy?.label ?? null,
      source: proxy === null ? null : (proxy.source ?? 'byo'),
    });
  }

  /** `session.closed`: the settlement event the broker, recorder and WS react to. */
  closed(session: Session, reason: ClosedReason, at: number): void {
    this.deps.bus.publish('session.closed', {
      type: 'session.closed',
      session_id: SessionId.parse(session.id),
      closed_at: at,
      reason,
    });
    this.deps.logger.info('session closed', { sessionId: session.id, reason });
  }
}

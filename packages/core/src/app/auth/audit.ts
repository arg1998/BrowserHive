/** @module app/auth/audit — writes `auth_events` rows, publishes `auth.*` bus events and logs them (spec 03 §3.4). */

import type { AuthEventType } from '../../ports/persistence/enums.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import { authEventName } from './events.ts';
import type { AuthDeps } from './types.ts';

/** What a caller knows about the request that produced an audit event. */
export interface AuditInput {
  readonly principalId: string | null;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly details?: JsonObject;
}

/** Records authentication audit events. */
export interface AuthAudit {
  /** Appends the row, publishes `auth.<type>` and logs at `info` (`warn` for failures). */
  record(type: AuthEventType, input: AuditInput): Promise<void>;
}

const FAILURE_TYPES: ReadonlySet<AuthEventType> = new Set([
  'login_failure',
  'lockout',
  'unauthorized',
]);

const MESSAGES: { readonly [T in AuthEventType]: string } = {
  login_success: 'login succeeded',
  login_failure: 'login failed',
  lockout: 'login locked out',
  logout: 'logged out',
  password_changed: 'password changed',
  token_issued: 'token issued',
  token_revoked: 'token revoked',
  grant_issued: 'grant issued',
  session_revoked: 'session revoked',
  unauthorized: 'auth rejected',
};

/** Builds the {@link AuthAudit} over the repositories, bus and logger in `deps`. */
export function createAuthAudit(
  deps: Pick<AuthDeps, 'repos' | 'clock' | 'ids' | 'logger' | 'bus'>,
): AuthAudit {
  const log = deps.logger.child({ module: 'auth.audit' });
  return {
    async record(type, input) {
      const event = {
        eventId: deps.ids.eventId(),
        type,
        principalId: input.principalId,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        details: input.details ?? null,
        occurredAt: deps.clock.now(),
      };
      await deps.repos.authEvents.append(event);
      deps.bus?.publish(authEventName(type), event);
      const fields = {
        type,
        ...(input.principalId !== null && { principal: input.principalId }),
        ...(input.ip !== undefined && { ip: input.ip }),
        ...(input.details !== undefined && { details: input.details }),
      };
      if (FAILURE_TYPES.has(type)) log.warn(MESSAGES[type], fields);
      else log.info(MESSAGES[type], fields);
    },
  };
}

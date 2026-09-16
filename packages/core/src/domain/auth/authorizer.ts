/** @module domain/auth/authorizer — the one enforcement point: `Authorizer.can(principal, scope, resource?)` (spec 03 §3.5). */

import type { Scope } from '@browserhive/contracts/enums';
import { PASSWORD_CHANGE_ALLOWED_OPERATIONS } from '@browserhive/contracts/http';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { RequestPrincipal } from './principal.ts';

/**
 * A resource the caller wants to touch. Ownership is decided here only when the caller passes
 * an `owner`; the sessions service is the one that looks the owner up for every tool (D-09).
 */
export interface AuthorizedResource {
  readonly kind: 'session' | 'auth_session' | 'credential' | 'other';
  readonly id: string;
  /** Principal id that owns the resource, when ownership applies. */
  readonly owner?: string;
}

/** Route/tool-level policy. `scope: null` means "any authenticated principal". */
export interface Authorizer {
  /** True when `principal` may perform an action requiring `scope` on `resource`. */
  can(
    principal: RequestPrincipal | null,
    scope: Scope | null,
    resource?: AuthorizedResource,
  ): boolean;
  /** Throws `UNAUTHORIZED` (no principal) or `FORBIDDEN {scope}` when {@link Authorizer.can} is false. */
  assertCan(
    principal: RequestPrincipal | null,
    scope: Scope | null,
    resource?: AuthorizedResource,
  ): asserts principal is RequestPrincipal;
  /** True when the principal may reach `operationId` while still on the seed password. */
  allowedDuringPasswordChange(principal: RequestPrincipal, operationId: string): boolean;
}

/**
 * v1 policy table:
 * - operators can do everything (they hold every scope; ownership never restricts them);
 * - agents and operator API tokens are limited to the scopes their credential carries;
 * - when a resource names an `owner`, non-operators must be that owner.
 */
export function can(
  principal: RequestPrincipal | null,
  scope: Scope | null,
  resource?: AuthorizedResource,
): boolean {
  if (principal === null) return false;
  if (principal.kind === 'operator') return true;
  if (scope !== null && !principal.scopes.includes(scope)) return false;
  if (resource?.owner !== undefined && resource.owner !== principal.subject) return false;
  return true;
}

/** See {@link Authorizer.assertCan}. */
export function assertCan(
  principal: RequestPrincipal | null,
  scope: Scope | null,
  resource?: AuthorizedResource,
): asserts principal is RequestPrincipal {
  if (principal === null) throw new AppError('UNAUTHORIZED', {});
  if (!can(principal, scope, resource)) {
    throw new AppError(
      'FORBIDDEN',
      { scope: scope ?? 'ownership' },
      {
        message:
          scope === null
            ? `principal ${principal.subject} does not own ${resource?.kind ?? 'resource'} ${resource?.id ?? ''}`
            : `principal ${principal.subject} lacks scope ${scope}`,
      },
    );
  }
}

const PASSWORD_CHANGE_OPERATIONS: ReadonlySet<string> = new Set(PASSWORD_CHANGE_ALLOWED_OPERATIONS);

/** See {@link Authorizer.allowedDuringPasswordChange}. */
export function allowedDuringPasswordChange(
  principal: RequestPrincipal,
  operationId: string,
): boolean {
  return !principal.mustChangePassword || PASSWORD_CHANGE_OPERATIONS.has(operationId);
}

/** The v1 {@link Authorizer}. Stateless; share one instance. */
export const authorizer: Authorizer = Object.freeze({
  can,
  assertCan,
  allowedDuringPasswordChange,
});

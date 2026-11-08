/** @module domain/auth/authorizer — the one enforcement point: `Authorizer.can(principal, scope, resource?)` (spec 03 §3.5). */

import type { Scope } from '@browserhive/contracts/enums';
import { PASSWORD_CHANGE_ALLOWED_OPERATIONS } from '@browserhive/contracts/http';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { RequestPrincipal } from './principal.ts';
import { isSubsetOf, OPERATOR_SCOPES } from './scopes.ts';

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
  /** True for a dashboard-session operator or an operator token holding every operator scope. */
  hasFullOperatorAccess(principal: RequestPrincipal): boolean;
  /** True when the principal may reach `operationId` while still on the seed password. */
  allowedDuringPasswordChange(principal: RequestPrincipal, operationId: string): boolean;
}

/**
 * True when the principal is an operator established by the dashboard (a password-session cookie,
 * or a grant minted from one). Such an operator holds every scope whatever list it carries. The
 * credential type decides, never the subject: an operator API token is a `bearer` principal and is
 * limited to its credential's scopes (spec 03 §3.5).
 */
function isOperatorSession(principal: RequestPrincipal): boolean {
  if (principal.kind !== 'operator') return false;
  const method = principal.auth.method;
  return method === 'password-session' || method === 'grant';
}

/**
 * True when the principal may act as the whole operator: a dashboard-session operator, or an
 * operator API token whose credential carries every operator scope (one issued without `scopes`).
 * Scope-less account administration (tokens, grants, auth sessions, the password) requires it, so
 * a narrowed token can never mint a wider one.
 */
export function hasFullOperatorAccess(principal: RequestPrincipal): boolean {
  if (principal.kind !== 'operator') return false;
  if (isOperatorSession(principal)) return true;
  return isSubsetOf(OPERATOR_SCOPES, principal.scopes);
}

/**
 * v1 policy table:
 * - a dashboard-session operator holds every scope;
 * - every principal authenticated by an API token, operator or agent, is limited to the scopes
 *   its credential carries;
 * - ownership never restricts an operator (session or token); when a resource names an `owner`,
 *   every other principal must be that owner.
 */
export function can(
  principal: RequestPrincipal | null,
  scope: Scope | null,
  resource?: AuthorizedResource,
): boolean {
  if (principal === null) return false;
  if (scope !== null && !isOperatorSession(principal) && !principal.scopes.includes(scope)) {
    return false;
  }
  if (principal.kind === 'operator') return true;
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
  hasFullOperatorAccess,
  allowedDuringPasswordChange,
});

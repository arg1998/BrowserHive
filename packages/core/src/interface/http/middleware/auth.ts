/** @module interface/http/middleware/auth — middleware 7–9: authentication via the provider chain, the password-change gate and scope authorization (spec 03 §2–3). */

import type { AuthMethod, Scope } from '@browserhive/contracts/enums';
import type { GrantRoute } from '@browserhive/contracts/http';
import type { Authenticator } from '../../../app/auth/authenticate.ts';
import type { AuthRequestView, AuthTransport } from '../../../app/auth/types.ts';
import { authorizer } from '../../../domain/auth/authorizer.ts';
import type { RequestPrincipal } from '../../../domain/auth/principal.ts';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { HttpContext } from '../env.ts';

/** Operations a non-operator principal may reach on scope-less routes. */
const AGENT_SCOPELESS_OPERATIONS: ReadonlySet<string> = new Set(['getMe']);

/** Builds the framework-free request view the provider chain consumes. */
export function authViewOf(
  c: HttpContext,
  transport: AuthTransport,
  grantRoute?: { readonly route: GrantRoute; readonly resourceId: string },
): AuthRequestView {
  const authorization = c.req.header('authorization');
  const cookie = c.req.header('cookie');
  const grant = new URL(c.req.url).searchParams.get('grant');
  const userAgent = c.req.header('user-agent');
  return {
    headers: {
      ...(authorization !== undefined && { authorization }),
      ...(cookie !== undefined && { cookie }),
    },
    query: grant === null ? {} : { grant },
    transport,
    remoteLoopback: c.get('remoteLoopback'),
    ip: c.get('clientIp'),
    ...(userAgent !== undefined && { userAgent }),
    ...(grantRoute !== undefined && { grantRoute }),
  };
}

/** The route facts authentication and authorization need. */
export interface GuardedRoute {
  readonly operationId: string;
  readonly scope: Scope | null;
  readonly auth: readonly AuthMethod[];
}

/**
 * Runs the admin chain for a non-public route. No credential → `UNAUTHORIZED`; a credential of a
 * method the route does not accept (a grant elsewhere, the local principal) → `UNAUTHORIZED`.
 * Present-but-invalid credentials already throw inside the chain (never fall through).
 */
export async function authenticateRoute(
  authenticator: Authenticator,
  view: AuthRequestView,
  route: GuardedRoute,
): Promise<RequestPrincipal> {
  const principal = await authenticator.authenticate(view);
  if (principal === null) throw new AppError('UNAUTHORIZED', {});
  const method = principal.auth.method;
  if (method === 'local' || !route.auth.includes(method)) {
    throw new AppError('UNAUTHORIZED', {}, { message: `${method} not accepted here` });
  }
  return principal;
}

/**
 * `passwordChangeGate` then `authorize`: a principal on the seed password reaches only the three
 * allowed operations (403 `PASSWORD_CHANGE_REQUIRED`); the route scope is checked by the one
 * `Authorizer` (403 `FORBIDDEN`); scope-less admin routes are operator-only except `getMe`.
 */
export function authorizeRoute(principal: RequestPrincipal, route: GuardedRoute): void {
  if (!authorizer.allowedDuringPasswordChange(principal, route.operationId)) {
    throw new AppError('PASSWORD_CHANGE_REQUIRED', {});
  }
  if (
    route.scope === null &&
    principal.kind !== 'operator' &&
    !AGENT_SCOPELESS_OPERATIONS.has(route.operationId)
  ) {
    throw new AppError('FORBIDDEN', { scope: 'operator' });
  }
  authorizer.assertCan(principal, route.scope);
}

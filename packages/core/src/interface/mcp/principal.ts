/** @module interface/mcp/principal — carries the authenticated principal through the SDK's `authInfo` and reads it back without casts. */

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { LOCAL_PRINCIPAL, type RequestPrincipal } from '../../domain/auth/principal.ts';

const PRINCIPAL_KEY = 'browserhive.principal';

/** Wraps a principal as SDK `authInfo` (the HTTP layer already authenticated the bearer token). */
export function authInfoFor(principal: RequestPrincipal): AuthInfo {
  return {
    token: '',
    clientId: principal.subject,
    scopes: [...principal.scopes],
    extra: { [PRINCIPAL_KEY]: principal },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** Structural guard for a {@link RequestPrincipal} carried through `authInfo.extra`. */
export function isRequestPrincipal(value: unknown): value is RequestPrincipal {
  if (!isRecord(value)) return false;
  const auth = value['auth'];
  return (
    typeof value['subject'] === 'string' &&
    (value['kind'] === 'operator' || value['kind'] === 'agent' || value['kind'] === 'service') &&
    typeof value['display'] === 'string' &&
    isRecord(auth) &&
    typeof auth['method'] === 'string' &&
    Array.isArray(value['scopes']) &&
    value['tenantId'] === null &&
    typeof value['mustChangePassword'] === 'boolean'
  );
}

/** The principal of a request: from `authInfo`, else the shared `local` principal (auth=off, stdio). */
export function principalFromAuthInfo(authInfo: AuthInfo | undefined): RequestPrincipal {
  const candidate = authInfo?.extra?.[PRINCIPAL_KEY];
  return isRequestPrincipal(candidate) ? candidate : LOCAL_PRINCIPAL;
}

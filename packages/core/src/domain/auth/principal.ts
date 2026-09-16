/** @module domain/auth/principal — `RequestPrincipal`, the local principal and principal factories (D-09, spec 03 §3.1). */

import type { AuthMethod, PrincipalKind, Scope } from '@browserhive/contracts/enums';
import type { PrincipalRecord } from '../../ports/persistence/records-identity.ts';
import { AGENT_SCOPES, scopesForKind } from './scopes.ts';

/** How a principal was established; `local` is the no-auth front door (never on the wire). */
export type PrincipalAuthMethod = AuthMethod | 'local';

/** Provenance of the authentication that produced a principal. */
export interface PrincipalAuth {
  readonly method: PrincipalAuthMethod;
  /** `auth_sessions.auth_session_id` for cookie and grant principals. */
  readonly sessionId?: string;
  /** `credentials.credential_id` for bearer principals. */
  readonly credentialId?: string;
  /** Absolute expiry of the credential that authenticated the request, when it has one. */
  readonly expiresAt?: number;
}

/**
 * The authenticated caller of a request, tool call or WS command. Produced only by the
 * authentication provider chain; the MCP `caller` is the same object.
 */
export interface RequestPrincipal {
  /** `principals.principal_id`. */
  readonly subject: string;
  readonly kind: PrincipalKind;
  readonly display: string;
  readonly auth: PrincipalAuth;
  /** Resolved from kind + credential scopes. */
  readonly scopes: readonly Scope[];
  /** Always `null` in v1 (D-09). */
  readonly tenantId: null;
  /** Operators still on the seed password may only reach the password-change routes. */
  readonly mustChangePassword: boolean;
}

/** Subject of the shared no-auth principal. */
export const LOCAL_SUBJECT = 'local';

/**
 * The single shared principal used when `auth=off` (loopback HTTP) or under stdio. Every browser
 * session is owned by it; the admin API never uses it (spec 03 §3.1).
 */
export const LOCAL_PRINCIPAL: RequestPrincipal = Object.freeze({
  subject: LOCAL_SUBJECT,
  kind: 'agent',
  display: 'local',
  auth: Object.freeze({ method: 'local' as const }),
  scopes: AGENT_SCOPES,
  tenantId: null,
  mustChangePassword: false,
});

/** Options for {@link principalFromRecord}. */
export interface PrincipalFromRecordOptions {
  readonly auth: PrincipalAuth;
  /** Credential-granted subset; an empty list means the kind's full set. */
  readonly scopes?: readonly Scope[];
}

/** Builds a {@link RequestPrincipal} from a `principals` row and the authentication that resolved it. */
export function principalFromRecord(
  record: PrincipalRecord,
  options: PrincipalFromRecordOptions,
): RequestPrincipal {
  const scopes =
    options.scopes !== undefined && options.scopes.length > 0
      ? options.scopes
      : scopesForKind(record.kind);
  return {
    subject: record.principalId,
    kind: record.kind,
    display: record.display,
    auth: options.auth,
    scopes,
    tenantId: null,
    mustChangePassword: record.kind === 'operator' && record.mustChangePassword,
  };
}

/** Builds an agent principal for a bearer token (the MCP `caller`). */
export function agentPrincipal(
  subject: string,
  options: {
    readonly display?: string;
    readonly credentialId?: string;
    readonly expiresAt?: number;
  },
): RequestPrincipal {
  return {
    subject,
    kind: 'agent',
    display: options.display ?? subject,
    auth: {
      method: 'bearer',
      ...(options.credentialId !== undefined && { credentialId: options.credentialId }),
      ...(options.expiresAt !== undefined && { expiresAt: options.expiresAt }),
    },
    scopes: AGENT_SCOPES,
    tenantId: null,
    mustChangePassword: false,
  };
}

/** True for the shared no-auth principal. */
export function isLocalPrincipal(principal: RequestPrincipal): boolean {
  return principal.subject === LOCAL_SUBJECT && principal.auth.method === 'local';
}

/** True when the principal was established by an operator cookie session. */
export function isSessionPrincipal(principal: RequestPrincipal): principal is RequestPrincipal & {
  readonly auth: PrincipalAuth & { readonly sessionId: string };
} {
  return principal.auth.method === 'password-session' && principal.auth.sessionId !== undefined;
}

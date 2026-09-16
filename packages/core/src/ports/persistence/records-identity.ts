/** @module ports/persistence/records-identity — principal, credential, auth session, grant, auth event and MCP connection records (D-09). */

import type { AuthEventType, CredentialKind, McpTransport, PrincipalKind } from './enums.ts';
import type { JsonObject } from './json.ts';

// --- identity ---------------------------------------------------------------------------------

/** A principal (`principals`). */
export interface PrincipalRecord {
  readonly principalId: string;
  readonly kind: PrincipalKind;
  readonly display: string;
  readonly tenantId: string | null;
  readonly mustChangePassword: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly disabledAt: number | null;
}

/** A hashed secret (`credentials`). `secretHash` never leaves the auth service. */
export interface CredentialRecord {
  readonly credentialId: string;
  readonly principalId: string;
  readonly kind: CredentialKind;
  readonly publicPrefix: string | null;
  readonly secretHash: string;
  readonly display: string | null;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

/** An operator cookie session (`auth_sessions`). */
export interface AuthSessionRecord {
  readonly authSessionId: string;
  readonly principalId: string;
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly revokedAt: number | null;
}

/** A short-lived resource grant (`grants`). */
export interface GrantRecord {
  readonly grantId: string;
  readonly tokenHash: string;
  readonly authSessionId: string;
  readonly route: string;
  readonly resourceId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | null;
}

/** An authentication audit row (`auth_events`); `seq` is assigned on insert. */
export interface AuthEventRecord {
  readonly seq: number;
  readonly eventId: string;
  readonly type: AuthEventType;
  readonly principalId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly details: JsonObject | null;
  readonly occurredAt: number;
}

/** Input for {@link AuthEventRecord} (no `seq`). */
export type NewAuthEvent = Omit<AuthEventRecord, 'seq'>;

// --- mcp connections --------------------------------------------------------------------------

/** Self-reported MCP client metadata (`mcp_connections`); never used for access control. */
export interface McpConnectionRecord {
  readonly connectionId: string;
  readonly principalId: string | null;
  readonly transport: McpTransport;
  readonly mcpSessionId: string | null;
  readonly clientName: string | null;
  readonly clientVersion: string | null;
  readonly protocolVersion: string | null;
  readonly capabilities: JsonObject | null;
  readonly agentName: string | null;
  readonly model: string | null;
  readonly harness: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly connectedAt: number;
  readonly lastSeenAt: number;
  readonly closedAt: number | null;
}

/** @module infra/persistence/mappers/identity — principals, credentials, auth_sessions, grants, auth_events rows ↔ records. */

import type { Insertable, Selectable, Updateable } from 'kysely';
import {
  AUTH_EVENT_TYPES,
  CREDENTIAL_KINDS,
  PRINCIPAL_KINDS,
} from '../../../ports/persistence/enums.ts';
import type { PrincipalPatch } from '../../../ports/persistence/identity.ts';
import type {
  AuthEventRecord,
  AuthSessionRecord,
  CredentialRecord,
  GrantRecord,
  NewAuthEvent,
  PrincipalRecord,
} from '../../../ports/persistence/records.ts';
import type {
  AuthEvents,
  AuthSessions,
  Credentials,
  Grants,
  Principals,
} from '../generated/db.d.ts';
import {
  boolToInt,
  intToBool,
  parseEnum,
  parseJsonObjectOrNull,
  parseStringArray,
  toJson,
  toJsonOrNull,
} from './codec.ts';

/** `principals` row → record. */
export function principalFromRow(row: Selectable<Principals>): PrincipalRecord {
  return {
    principalId: row.principal_id,
    kind: parseEnum(PRINCIPAL_KINDS, row.kind, `principals.${row.principal_id}`),
    display: row.display,
    tenantId: row.tenant_id,
    mustChangePassword: intToBool(row.must_change_password),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at,
  };
}

/** Record → `principals` insert row. */
export function principalToRow(record: PrincipalRecord): Selectable<Principals> {
  return {
    principal_id: record.principalId,
    kind: record.kind,
    display: record.display,
    tenant_id: record.tenantId,
    must_change_password: boolToInt(record.mustChangePassword),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    disabled_at: record.disabledAt,
  };
}

/** Patch → `principals` update row. */
export function principalPatchToRow(patch: PrincipalPatch): Updateable<Principals> {
  return {
    ...(patch.display !== undefined && { display: patch.display }),
    ...(patch.mustChangePassword !== undefined && {
      must_change_password: boolToInt(patch.mustChangePassword),
    }),
    ...(patch.disabledAt !== undefined && { disabled_at: patch.disabledAt }),
    ...(patch.updatedAt !== undefined && { updated_at: patch.updatedAt }),
  };
}

/** `credentials` row → record. */
export function credentialFromRow(row: Selectable<Credentials>): CredentialRecord {
  const where = `credentials.${row.credential_id}`;
  return {
    credentialId: row.credential_id,
    principalId: row.principal_id,
    kind: parseEnum(CREDENTIAL_KINDS, row.kind, where),
    publicPrefix: row.public_prefix,
    secretHash: row.secret_hash,
    display: row.display,
    scopes: parseStringArray(row.scopes_json, where),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** Record → `credentials` insert row. */
export function credentialToRow(record: CredentialRecord): Selectable<Credentials> {
  return {
    credential_id: record.credentialId,
    principal_id: record.principalId,
    kind: record.kind,
    public_prefix: record.publicPrefix,
    secret_hash: record.secretHash,
    display: record.display,
    scopes_json: toJson(record.scopes),
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    last_used_at: record.lastUsedAt,
    revoked_at: record.revokedAt,
  };
}

/** `auth_sessions` row → record. */
export function authSessionFromRow(row: Selectable<AuthSessions>): AuthSessionRecord {
  return {
    authSessionId: row.auth_session_id,
    principalId: row.principal_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    userAgent: row.user_agent,
    ip: row.ip,
    revokedAt: row.revoked_at,
  };
}

/** Record → `auth_sessions` insert row. */
export function authSessionToRow(record: AuthSessionRecord): Selectable<AuthSessions> {
  return {
    auth_session_id: record.authSessionId,
    principal_id: record.principalId,
    token_hash: record.tokenHash,
    created_at: record.createdAt,
    last_seen_at: record.lastSeenAt,
    expires_at: record.expiresAt,
    user_agent: record.userAgent,
    ip: record.ip,
    revoked_at: record.revokedAt,
  };
}

/** `grants` row → record. */
export function grantFromRow(row: Selectable<Grants>): GrantRecord {
  return {
    grantId: row.grant_id,
    tokenHash: row.token_hash,
    authSessionId: row.auth_session_id,
    route: row.route,
    resourceId: row.resource_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

/** Record → `grants` insert row. */
export function grantToRow(record: GrantRecord): Selectable<Grants> {
  return {
    grant_id: record.grantId,
    token_hash: record.tokenHash,
    auth_session_id: record.authSessionId,
    route: record.route,
    resource_id: record.resourceId,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    used_at: record.usedAt,
  };
}

/** `auth_events` row → record. */
export function authEventFromRow(row: Selectable<AuthEvents>): AuthEventRecord {
  const where = `auth_events.${row.event_id}`;
  return {
    seq: row.seq,
    eventId: row.event_id,
    type: parseEnum(AUTH_EVENT_TYPES, row.type, where),
    principalId: row.principal_id,
    ip: row.ip,
    userAgent: row.user_agent,
    details: parseJsonObjectOrNull(row.details_json, where),
    occurredAt: row.occurred_at,
  };
}

/** New event → `auth_events` insert row. */
export function authEventToRow(event: NewAuthEvent): Insertable<AuthEvents> {
  return {
    event_id: event.eventId,
    type: event.type,
    principal_id: event.principalId,
    ip: event.ip,
    user_agent: event.userAgent,
    details_json: toJsonOrNull(event.details),
    occurred_at: event.occurredAt,
  };
}

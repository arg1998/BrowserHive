/** @module ports/persistence/identity — principals, credentials, auth sessions, grants and auth events (D-09). */

import type { CredentialKind, PrincipalKind } from './enums.ts';
import type { AuditListQuery, Page } from './queries.ts';
import type {
  AuthEventRecord,
  AuthSessionRecord,
  CredentialRecord,
  GrantRecord,
  NewAuthEvent,
  PrincipalRecord,
} from './records.ts';

/** Mutable subset of a principal. */
export type PrincipalPatch = Partial<
  Pick<PrincipalRecord, 'display' | 'mustChangePassword' | 'disabledAt' | 'updatedAt'>
>;

/** Repository over `principals`. */
export interface PrincipalRepository {
  /** Inserts a principal; duplicate id is ignored. */
  insert(record: PrincipalRecord): Promise<void>;
  /** Fetches one principal or `null`. */
  get(principalId: string): Promise<PrincipalRecord | null>;
  /** Lists principals, optionally by kind, ordered by creation. */
  list(kind?: PrincipalKind): Promise<readonly PrincipalRecord[]>;
  /** Applies a partial update; returns true when a row changed. */
  update(principalId: string, patch: PrincipalPatch): Promise<boolean>;
}

/** Repository over `credentials`. */
export interface CredentialRepository {
  /** Inserts a credential; duplicate id is ignored. */
  insert(record: CredentialRecord): Promise<void>;
  /** Fetches one credential or `null`. */
  get(credentialId: string): Promise<CredentialRecord | null>;
  /** Unrevoked credential with this public prefix, or `null`. */
  findByPrefix(publicPrefix: string): Promise<CredentialRecord | null>;
  /** Credentials of a principal, optionally by kind, including revoked ones. */
  listByPrincipal(principalId: string, kind?: CredentialKind): Promise<readonly CredentialRecord[]>;
  /** All unrevoked credentials of a kind (token listing). */
  listActive(kind: CredentialKind): Promise<readonly CredentialRecord[]>;
  /** Replaces the secret hash (password change). */
  replaceSecret(credentialId: string, secretHash: string): Promise<boolean>;
  /** Stamps `last_used_at`. */
  touch(credentialId: string, at: number): Promise<void>;
  /** Sets `revoked_at` when not already revoked. */
  revoke(credentialId: string, at: number): Promise<boolean>;
}

/** Repository over `auth_sessions`. */
export interface AuthSessionRepository {
  /** Inserts an operator session; duplicate id is ignored. */
  insert(record: AuthSessionRecord): Promise<void>;
  /** Fetches one auth session or `null`. */
  get(authSessionId: string): Promise<AuthSessionRecord | null>;
  /** Unrevoked, unexpired session with this token hash, or `null`. */
  findByTokenHash(tokenHash: string, now: number): Promise<AuthSessionRecord | null>;
  /** Unrevoked sessions of a principal, newest first. */
  listActive(principalId: string): Promise<readonly AuthSessionRecord[]>;
  /** Stamps `last_seen_at` (and optionally extends `expires_at`). */
  touch(authSessionId: string, at: number, expiresAt?: number): Promise<void>;
  /** Sets `revoked_at`; returns false when already revoked or unknown. */
  revoke(authSessionId: string, at: number): Promise<boolean>;
  /** Revokes every active session of a principal except `keep`; returns the count. */
  revokeAll(principalId: string, at: number, keep?: string): Promise<number>;
  /** Deletes sessions expired or revoked before `before`; returns the count. */
  pruneExpired(before: number): Promise<number>;
}

/** Repository over `grants`. */
export interface GrantRepository {
  /** Inserts a grant; duplicate id is ignored. */
  insert(record: GrantRecord): Promise<void>;
  /** Unexpired grant with this token hash, or `null`. */
  findByTokenHash(tokenHash: string, now: number): Promise<GrantRecord | null>;
  /** Stamps `used_at`. */
  markUsed(grantId: string, at: number): Promise<void>;
  /** Deletes grants expired before `before`; returns the count. */
  pruneExpired(before: number): Promise<number>;
}

/** Repository over `auth_events` (audit class). */
export interface AuthEventRepository {
  /** Appends an audit event and returns its `seq`. */
  append(event: NewAuthEvent): Promise<number>;
  /** Lists audit events newest first. */
  list(query: AuditListQuery): Promise<Page<AuthEventRecord>>;
}

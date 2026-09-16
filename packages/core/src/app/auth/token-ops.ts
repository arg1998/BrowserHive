/** @module app/auth/token-ops — API token issue/list/revoke and the first-start agent token (spec 02 §1.3, 03 §4.1). */

import type { Scope } from '@browserhive/contracts/enums';
import type { TokenOwnerKind } from '@browserhive/contracts/http';
import { sha256Hex } from '../../domain/auth/digest.ts';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import { isSubsetOf, parseScopes, scopesForKind } from '../../domain/auth/scopes.ts';
import { mintToken } from '../../domain/auth/token-format.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { type Secret, secret } from '../../kernel/secret.ts';
import { sanitizeSlug } from '../../kernel/slug.ts';
import type {
  CredentialRecord,
  PrincipalRecord,
} from '../../ports/persistence/records-identity.ts';
import type { AuthAudit } from './audit.ts';
import type { AuthDeps } from './types.ts';

/** Principal of the token seeded on first start under `auth=token` (`agent-1`). */
export const SEED_AGENT_PRINCIPAL_ID = 'agent-1';

/** Input of {@link TokenOps.createToken}. */
export interface CreateTokenInput {
  readonly ownerKind: TokenOwnerKind;
  readonly display: string;
  /** Subset of the owner kind's scopes; defaults to the full set. */
  readonly scopes?: readonly Scope[];
  readonly expiresInMs?: number;
  /** Agent tokens: principal id to (re)use; defaults to a slug of `display`. */
  readonly subject?: string;
}

/** Result of {@link TokenOps.createToken}; `token` is shown exactly once. */
export interface CreateTokenResult {
  readonly credentialId: string;
  readonly principalId: string;
  readonly publicPrefix: string;
  readonly token: Secret<string>;
  readonly expiresAt: number | null;
}

/** One row of `GET /auth/tokens`. */
export interface ApiTokenView {
  readonly credentialId: string;
  readonly publicPrefix: string;
  readonly ownerKind: TokenOwnerKind;
  readonly subject: string;
  readonly display: string | null;
  readonly scopes: readonly Scope[];
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
}

/** Outcome of {@link TokenOps.seedAgentToken}. */
export type SeedTokenResult =
  | { readonly seeded: false }
  | { readonly seeded: true; readonly principalId: string; readonly token: Secret<string> };

/** API token operations. */
export interface TokenOps {
  createToken(issuer: RequestPrincipal, input: CreateTokenInput): Promise<CreateTokenResult>;
  listTokens(): Promise<readonly ApiTokenView[]>;
  /** Revokes by credential id or public prefix; `NOT_FOUND` when unknown or already revoked. */
  revokeToken(issuer: RequestPrincipal, credentialIdOrPrefix: string): Promise<void>;
  /** `auth=token` first start: seeds `agent-1` when no stored or config token exists. */
  seedAgentToken(): Promise<SeedTokenResult>;
}

/** Internal dependencies of {@link createTokenOps}. */
export interface TokenOpsDeps extends AuthDeps {
  readonly audit: AuthAudit;
}

/** Builds the {@link TokenOps}. */
export function createTokenOps(deps: TokenOpsDeps): TokenOps {
  const { repos, clock, audit } = deps;

  const ensureAgentPrincipal = async (
    principalId: string,
    display: string,
  ): Promise<PrincipalRecord> => {
    const existing = await repos.principals.get(principalId);
    if (existing !== null) {
      if (existing.kind !== 'agent') {
        throw new AppError(
          'CONFLICT',
          {},
          { publicMessage: `principal '${principalId}' is not an agent` },
        );
      }
      return existing;
    }
    const now = clock.now();
    const record: PrincipalRecord = {
      principalId,
      kind: 'agent',
      display,
      tenantId: null,
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    };
    await repos.principals.insert(record);
    return record;
  };

  const issue = async (
    principal: PrincipalRecord,
    kind: TokenOwnerKind,
    display: string,
    scopes: readonly Scope[],
    expiresAt: number | null,
    issuer: string | null,
  ): Promise<CreateTokenResult> => {
    const { token, publicPrefix } = mintToken(deps.random, kind);
    deps.registerSecret?.(token);
    const credential: CredentialRecord = {
      credentialId: deps.ids.opaque(16),
      principalId: principal.principalId,
      kind: 'api_token',
      publicPrefix,
      secretHash: sha256Hex(token),
      display,
      scopes,
      createdAt: clock.now(),
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    await repos.credentials.insert(credential);
    await audit.record('token_issued', {
      principalId: issuer,
      details: {
        credential_id: credential.credentialId,
        subject: principal.principalId,
        public_prefix: publicPrefix,
        owner_kind: kind,
      },
    });
    return {
      credentialId: credential.credentialId,
      principalId: principal.principalId,
      publicPrefix,
      token: secret(token),
      expiresAt,
    };
  };

  return {
    async createToken(issuer, input) {
      const allowed = scopesForKind(input.ownerKind);
      const scopes = input.scopes ?? allowed;
      if (scopes.length === 0 || !isSubsetOf(scopes, allowed)) {
        throw new AppError('VALIDATION_FAILED', {
          issues: [
            {
              path: 'scopes',
              message: `scopes must be a non-empty subset of the ${input.ownerKind} scopes`,
              code: 'invalid_scope',
            },
          ],
        });
      }
      const expiresAt = input.expiresInMs !== undefined ? clock.now() + input.expiresInMs : null;
      let owner: PrincipalRecord;
      if (input.ownerKind === 'operator') {
        const record = await repos.principals.get(issuer.subject);
        if (record === null || record.kind !== 'operator') {
          throw new AppError(
            'FORBIDDEN',
            { scope: 'operator' },
            { message: 'operator tokens need an operator issuer' },
          );
        }
        owner = record;
      } else {
        owner = await ensureAgentPrincipal(
          input.subject ?? sanitizeSlug(input.display),
          input.display,
        );
      }
      return issue(owner, input.ownerKind, input.display, scopes, expiresAt, issuer.subject);
    },

    async listTokens() {
      const credentials = await repos.credentials.listActive('api_token');
      const principals = new Map((await repos.principals.list()).map((p) => [p.principalId, p]));
      return credentials.map((c) => {
        const owner = principals.get(c.principalId);
        return {
          credentialId: c.credentialId,
          publicPrefix: c.publicPrefix ?? '',
          ownerKind: owner?.kind === 'operator' ? 'operator' : 'agent',
          subject: c.principalId,
          display: c.display,
          scopes: parseScopes(c.scopes),
          createdAt: c.createdAt,
          lastUsedAt: c.lastUsedAt,
          expiresAt: c.expiresAt,
        };
      });
    },

    async revokeToken(issuer, credentialIdOrPrefix) {
      const byId = await repos.credentials.get(credentialIdOrPrefix);
      const target = byId ?? (await repos.credentials.findByPrefix(credentialIdOrPrefix));
      if (target === null || target.kind !== 'api_token' || target.revokedAt !== null) {
        throw new AppError('NOT_FOUND', {});
      }
      await repos.credentials.revoke(target.credentialId, clock.now());
      await audit.record('token_revoked', {
        principalId: issuer.subject,
        details: {
          credential_id: target.credentialId,
          subject: target.principalId,
          public_prefix: target.publicPrefix,
        },
      });
    },

    async seedAgentToken() {
      if (deps.config.authTokens.length > 0) return { seeded: false };
      const active = await repos.credentials.listActive('api_token');
      if (active.length > 0) return { seeded: false };
      const principal = await ensureAgentPrincipal(
        SEED_AGENT_PRINCIPAL_ID,
        SEED_AGENT_PRINCIPAL_ID,
      );
      const issued = await issue(principal, 'agent', 'seed', scopesForKind('agent'), null, null);
      return { seeded: true, principalId: issued.principalId, token: issued.token };
    },
  };
}

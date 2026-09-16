/** @module app/auth/password-ops — password change, first-start seeding and CLI reset (spec 03 §3.4, D-09). */

import { assertPasswordPolicy } from '../../domain/auth/password-policy.ts';
import { isSessionPrincipal, type RequestPrincipal } from '../../domain/auth/principal.ts';
import { generateSeedPassword } from '../../domain/auth/token-format.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { type Secret, secret } from '../../kernel/secret.ts';
import type {
  CredentialRecord,
  PrincipalRecord,
} from '../../ports/persistence/records-identity.ts';
import type { AuthAudit } from './audit.ts';
import { findOperator, findPasswordCredential } from './session-ops.ts';
import type { AuthDeps } from './types.ts';

/** Principal id and display of the single v1 operator. */
export const ADMIN_PRINCIPAL_ID = 'admin';

/** Outcome of {@link PasswordOps.seedAdmin}. */
export type SeedResult =
  | { readonly seeded: false }
  | {
      readonly seeded: true;
      readonly principalId: string;
      /** The plaintext seed password; print once, never log. */
      readonly password: Secret<string>;
      /** Where the password was also written (0600). */
      readonly credentialsPath: string;
    };

/** Password-related operations. */
export interface PasswordOps {
  /** Verifies `current`, applies the policy, rehashes, revokes other sessions, shreds the seed file. */
  changePassword(
    principal: RequestPrincipal,
    current: Secret<string>,
    next: Secret<string>,
  ): Promise<{ readonly revokedSessions: number }>;
  /** First start: creates operator `admin` with a 24-char seed password and `must_change_password`. */
  seedAdmin(): Promise<SeedResult>;
  /** `browserhive admin reset-password`: re-seeds the operator password and revokes every session. */
  resetPassword(): Promise<Extract<SeedResult, { seeded: true }>>;
}

/** Internal dependencies of {@link createPasswordOps}. */
export interface PasswordOpsDeps extends AuthDeps {
  readonly audit: AuthAudit;
  /** Invoked exactly once per seeding with the plaintext (banner printing). */
  readonly onSeed?: ((seed: Extract<SeedResult, { seeded: true }>) => void) | undefined;
}

/** Builds the {@link PasswordOps}. */
export function createPasswordOps(deps: PasswordOpsDeps): PasswordOps {
  const { repos, clock, hasher, audit } = deps;
  const log = deps.logger.child({ module: 'auth.password' });

  const shredSeedFile = async (): Promise<void> => {
    try {
      await deps.credentialsFile.shred();
    } catch (error) {
      log.warn('seed file shred failed', {
        path: deps.credentialsFile.path,
        err: serializeError(error),
      });
    }
  };

  const seedFor = async (
    operator: PrincipalRecord,
    credential: CredentialRecord | null,
  ): Promise<Extract<SeedResult, { seeded: true }>> => {
    const password = generateSeedPassword(deps.random);
    deps.registerSecret?.(password);
    const hash = await hasher.hash(password);
    const now = clock.now();
    if (credential === null) {
      await repos.credentials.insert({
        credentialId: deps.ids.opaque(16),
        principalId: operator.principalId,
        kind: 'password',
        publicPrefix: null,
        secretHash: hash,
        display: null,
        scopes: [],
        createdAt: now,
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
      });
    } else {
      await repos.credentials.replaceSecret(credential.credentialId, hash);
    }
    await repos.principals.update(operator.principalId, {
      mustChangePassword: true,
      updatedAt: now,
    });
    const wrapped = secret(password);
    await deps.credentialsFile.write(wrapped);
    const result = {
      seeded: true as const,
      principalId: operator.principalId,
      password: wrapped,
      credentialsPath: deps.credentialsFile.path,
    };
    deps.onSeed?.(result);
    return result;
  };

  return {
    async changePassword(principal, current, next) {
      if (principal.kind !== 'operator') {
        throw new AppError(
          'FORBIDDEN',
          { scope: 'operator' },
          { message: 'only operators have a password' },
        );
      }
      const credential = await findPasswordCredential(deps, principal.subject);
      const currentPlain = current.reveal();
      if (credential === null || !(await hasher.verify(currentPlain, credential.secretHash))) {
        throw new AppError('BAD_CURRENT_PASSWORD', {});
      }
      const nextPlain = next.reveal();
      assertPasswordPolicy(nextPlain, currentPlain);
      const now = clock.now();
      await repos.credentials.replaceSecret(credential.credentialId, await hasher.hash(nextPlain));
      await repos.principals.update(principal.subject, {
        mustChangePassword: false,
        updatedAt: now,
      });
      const keep = isSessionPrincipal(principal) ? principal.auth.sessionId : undefined;
      const others = (await repos.authSessions.listActive(principal.subject)).filter(
        (s) => s.authSessionId !== keep,
      );
      const revokedSessions = await repos.authSessions.revokeAll(principal.subject, now, keep);
      for (const session of others) {
        await audit.record('session_revoked', {
          principalId: principal.subject,
          details: { auth_session_id: session.authSessionId, reason: 'password_changed' },
        });
      }
      await shredSeedFile();
      await audit.record('password_changed', {
        principalId: principal.subject,
        details: { revoked_sessions: revokedSessions },
      });
      return { revokedSessions };
    },

    async seedAdmin() {
      const existing = await findOperator(deps);
      if (existing !== null) return { seeded: false };
      const now = clock.now();
      const operator: PrincipalRecord = {
        principalId: ADMIN_PRINCIPAL_ID,
        kind: 'operator',
        display: ADMIN_PRINCIPAL_ID,
        tenantId: null,
        mustChangePassword: true,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      await repos.principals.insert(operator);
      const result = await seedFor(operator, null);
      log.info('operator seeded', {
        principal: operator.principalId,
        path: result.credentialsPath,
      });
      return result;
    },

    async resetPassword() {
      const operator = await findOperator(deps);
      if (operator === null) {
        const seeded = await this.seedAdmin();
        if (seeded.seeded) return seeded;
        throw new AppError('INTERNAL_ERROR', { ref: 'reset-password' }, { message: 'seed raced' });
      }
      const credential = await findPasswordCredential(deps, operator.principalId);
      const result = await seedFor(operator, credential);
      const now = clock.now();
      const sessions = await repos.authSessions.listActive(operator.principalId);
      await repos.authSessions.revokeAll(operator.principalId, now);
      for (const session of sessions) {
        await audit.record('session_revoked', {
          principalId: operator.principalId,
          details: { auth_session_id: session.authSessionId, reason: 'password_reset' },
        });
      }
      await audit.record('password_changed', {
        principalId: operator.principalId,
        details: { reason: 'reset', revoked_sessions: sessions.length },
      });
      return result;
    },
  };
}

/** @module app/auth/grant-ops — single-use, 10-minute grants for trace/screenshot links (spec 03 §3.2). */

import type { GrantRoute } from '@browserhive/contracts/http';
import { sha256Hex } from '../../domain/auth/digest.ts';
import { isSessionPrincipal, type RequestPrincipal } from '../../domain/auth/principal.ts';
import { mintToken } from '../../domain/auth/token-format.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { type Secret, secret } from '../../kernel/secret.ts';
import type { AuthAudit } from './audit.ts';
import type { AuthDeps } from './types.ts';

/** Input of {@link GrantOps.createGrant}. */
export interface CreateGrantInput {
  readonly route: GrantRoute;
  readonly resourceId: string;
}

/** Result of {@link GrantOps.createGrant}; `grant` goes into the `?grant=` query once. */
export interface CreateGrantResult {
  readonly grant: Secret<string>;
  readonly expiresAt: number;
}

/** Grant operations. */
export interface GrantOps {
  /** Mints a grant bound to the caller's cookie session; bearer callers get `VALIDATION_FAILED`. */
  createGrant(principal: RequestPrincipal, input: CreateGrantInput): Promise<CreateGrantResult>;
}

/** Internal dependencies of {@link createGrantOps}. */
export interface GrantOpsDeps extends AuthDeps {
  readonly audit: AuthAudit;
}

/** Builds the {@link GrantOps}. */
export function createGrantOps(deps: GrantOpsDeps): GrantOps {
  return {
    async createGrant(principal, input) {
      if (!isSessionPrincipal(principal)) {
        throw new AppError('VALIDATION_FAILED', {
          issues: [
            {
              path: 'route',
              message: 'grants require a cookie session; bearer clients send their token',
              code: 'no_session',
            },
          ],
        });
      }
      const now = deps.clock.now();
      const { token } = mintToken(deps.random, 'grant');
      deps.registerSecret?.(token);
      const grantId = deps.ids.opaque(16);
      const expiresAt = now + deps.config.grantTtlMs;
      await deps.repos.grants.insert({
        grantId,
        tokenHash: sha256Hex(token),
        authSessionId: principal.auth.sessionId,
        route: input.route,
        resourceId: input.resourceId,
        createdAt: now,
        expiresAt,
        usedAt: null,
      });
      await deps.audit.record('grant_issued', {
        principalId: principal.subject,
        details: {
          grant_id: grantId,
          route: input.route,
          resource_id: input.resourceId,
          expires_at: expiresAt,
        },
      });
      return { grant: secret(token), expiresAt };
    },
  };
}

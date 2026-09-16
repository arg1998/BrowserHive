/** @module app/auth/providers/grant — `?grant=<token>` on grant-enabled routes → the parent session's principal (spec 03 §3.2). */

import { sha256Hex } from '../../../domain/auth/digest.ts';
import { principalFromRecord } from '../../../domain/auth/principal.ts';
import { parseToken } from '../../../domain/auth/token-format.ts';
import type { AuthDeps } from '../types.ts';
import { type AuthenticationProvider, unauthorized } from './provider.ts';

/** Builds the grant provider. */
export function createGrantProvider(
  deps: Pick<AuthDeps, 'repos' | 'config'>,
): AuthenticationProvider {
  const name = 'grant';
  return {
    name,
    async authenticate(view, ctx) {
      const literal = view.query.grant;
      if (literal === undefined || literal.length === 0) return null;
      const route = view.grantRoute;
      if (route === undefined) throw unauthorized(name, 'route does not accept grants');
      const parsed = parseToken(literal);
      if (parsed === null || parsed.kind !== 'grant') throw unauthorized(name, 'malformed grant');
      const grant = await deps.repos.grants.findByTokenHash(sha256Hex(literal), ctx.now);
      if (grant === null) throw unauthorized(name, 'grant unknown or expired');
      if (grant.usedAt !== null && ctx.now - grant.usedAt >= deps.config.grantReuseWindowMs) {
        throw unauthorized(name, 'grant already used');
      }
      if (grant.route !== route.route || grant.resourceId !== route.resourceId) {
        throw unauthorized(name, 'grant bound to another resource');
      }
      const session = await deps.repos.authSessions.get(grant.authSessionId);
      if (session === null || session.revokedAt !== null || session.expiresAt <= ctx.now) {
        throw unauthorized(name, 'parent session revoked or expired');
      }
      const principal = await deps.repos.principals.get(session.principalId);
      if (principal === null || principal.disabledAt !== null) {
        throw unauthorized(name, 'principal missing or disabled');
      }
      if (grant.usedAt === null) await deps.repos.grants.markUsed(grant.grantId, ctx.now);
      return principalFromRecord(principal, {
        auth: { method: 'grant', sessionId: session.authSessionId, expiresAt: grant.expiresAt },
      });
    },
  };
}

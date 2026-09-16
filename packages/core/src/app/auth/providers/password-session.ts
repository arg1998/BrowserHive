/** @module app/auth/providers/password-session — cookie `browserhive_session` → operator principal with sliding idle window (spec 03 §3.3). */

import { sessionTokenFromCookie } from '../../../domain/auth/cookie.ts';
import { sha256Hex } from '../../../domain/auth/digest.ts';
import { principalFromRecord } from '../../../domain/auth/principal.ts';
import type { AuthDeps } from '../types.ts';
import { type AuthenticationProvider, unauthorized } from './provider.ts';

/** Builds the cookie-session provider. */
export function createPasswordSessionProvider(
  deps: Pick<AuthDeps, 'repos' | 'config'>,
): AuthenticationProvider {
  const name = 'password-session';
  return {
    name,
    async authenticate(view, ctx) {
      const token = sessionTokenFromCookie(view.headers.cookie);
      if (token === undefined) return null;
      const session = await deps.repos.authSessions.findByTokenHash(sha256Hex(token), ctx.now);
      if (session === null) throw unauthorized(name, 'session unknown, revoked or expired');
      if (ctx.now - session.lastSeenAt > deps.config.sessionIdleMs) {
        await deps.repos.authSessions.revoke(session.authSessionId, ctx.now);
        throw unauthorized(name, 'session idle timeout');
      }
      const principal = await deps.repos.principals.get(session.principalId);
      if (principal === null || principal.disabledAt !== null) {
        throw unauthorized(name, 'principal missing or disabled');
      }
      await deps.repos.authSessions.touch(session.authSessionId, ctx.now);
      return principalFromRecord(principal, {
        auth: {
          method: 'password-session',
          sessionId: session.authSessionId,
          expiresAt: session.expiresAt,
        },
      });
    },
  };
}

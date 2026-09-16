/** @module app/auth/session-ops — login, logout, me, operator session listing/revocation and the sliding touch (spec 03 §3.3, §4.1). */

import type { PrincipalKind, Scope } from '@browserhive/contracts/enums';
import {
  type CookieAttributes,
  clearSessionCookie,
  SESSION_COOKIE_NAME,
  type SetCookie,
  sessionCookie,
} from '../../domain/auth/cookie.ts';
import { sha256Hex } from '../../domain/auth/digest.ts';
import {
  isSessionPrincipal,
  principalFromRecord,
  type RequestPrincipal,
} from '../../domain/auth/principal.ts';
import { idPrefix, mintSecret } from '../../domain/auth/token-format.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { type Secret, secret } from '../../kernel/secret.ts';
import type {
  AuthSessionRecord,
  CredentialRecord,
  PrincipalRecord,
} from '../../ports/persistence/records-identity.ts';
import type { AuthAudit } from './audit.ts';
import type { LoginRateLimiter } from './rate-limit.ts';
import type { AuthDeps } from './types.ts';

/** Input of {@link SessionOps.login}. */
export interface LoginInput {
  readonly password: Secret<string>;
  readonly ip: string;
  readonly userAgent?: string;
  /** Request arrived over HTTPS (trusted proxy); sets the cookie's `Secure` flag. */
  readonly secure?: boolean;
}

/**
 * Result of a successful login. `token` is the cookie value, shown once; `cookie` carries the
 * name and attributes only, so the result never serializes the secret
 * (`serializeCookie({ ...cookie, value: token.reveal() })` at the HTTP edge).
 */
export interface LoginResult {
  readonly principal: RequestPrincipal;
  readonly token: Secret<string>;
  readonly cookie: { readonly name: string; readonly attributes: CookieAttributes };
  readonly session: {
    readonly authSessionId: string;
    readonly idPrefix: string;
    readonly expiresAt: number;
  };
  readonly mustChangePassword: boolean;
}

/** `GET /auth/me` view (camelCase; the HTTP layer maps to the wire DTO). */
export interface MeView {
  readonly principal: {
    readonly subject: string;
    readonly kind: PrincipalKind;
    readonly display: string;
    readonly scopes: readonly Scope[];
    readonly mustChangePassword: boolean;
  };
  readonly session?: {
    readonly idPrefix: string;
    readonly createdAt: number;
    readonly lastSeenAt: number;
    readonly expiresAt: number;
  };
}

/** One row of `GET /auth/sessions`. */
export interface AuthSessionView {
  readonly authSessionId: string;
  readonly idPrefix: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly current: boolean;
}

/** Operator session operations. */
export interface SessionOps {
  login(input: LoginInput): Promise<LoginResult>;
  /** Revokes the caller's cookie session (no-op for bearer principals); returns the clearing cookie. */
  logout(principal: RequestPrincipal, options?: { readonly secure?: boolean }): Promise<SetCookie>;
  me(principal: RequestPrincipal): Promise<MeView>;
  listSessions(principal: RequestPrincipal): Promise<readonly AuthSessionView[]>;
  /** Revokes one of the caller's sessions by id prefix; `NOT_FOUND` when none matches. */
  revokeSession(principal: RequestPrincipal, prefix: string): Promise<void>;
  /** Revokes every session of the caller except the current one; returns the count. */
  revokeAllSessions(principal: RequestPrincipal): Promise<number>;
  /** Slides the idle window of a live session (WS commands); false when it is gone. */
  touchSession(authSessionId: string): Promise<boolean>;
}

/** Internal dependencies of {@link createSessionOps}. */
export interface SessionOpsDeps extends AuthDeps {
  readonly audit: AuthAudit;
  readonly limiter: LoginRateLimiter;
}

/** The single operator principal of v1, or `null` before seeding. */
export async function findOperator(deps: Pick<AuthDeps, 'repos'>): Promise<PrincipalRecord | null> {
  const operators = await deps.repos.principals.list('operator');
  return operators.find((p) => p.disabledAt === null) ?? null;
}

/** The active password credential of a principal, or `null`. */
export async function findPasswordCredential(
  deps: Pick<AuthDeps, 'repos'>,
  principalId: string,
): Promise<CredentialRecord | null> {
  const credentials = await deps.repos.credentials.listByPrincipal(principalId, 'password');
  return credentials.find((c) => c.revokedAt === null) ?? null;
}

function isLive(session: AuthSessionRecord, now: number, idleMs: number): boolean {
  return (
    session.revokedAt === null && session.expiresAt > now && now - session.lastSeenAt <= idleMs
  );
}

/** Builds the {@link SessionOps}. */
export function createSessionOps(deps: SessionOpsDeps): SessionOps {
  const { repos, clock, config, audit } = deps;
  const log = deps.logger.child({ module: 'auth.sessions' });

  const revokeOne = async (
    session: AuthSessionRecord,
    reason: string,
    type: 'logout' | 'session_revoked',
  ): Promise<boolean> => {
    const revoked = await repos.authSessions.revoke(session.authSessionId, clock.now());
    if (revoked) {
      await audit.record(type, {
        principalId: session.principalId,
        ip: session.ip ?? undefined,
        details: { auth_session_id: session.authSessionId, reason },
      });
    }
    return revoked;
  };

  return {
    async login(input) {
      const decision = deps.limiter.attempt(input.ip);
      if (!decision.allowed) {
        if (decision.justLocked) {
          await audit.record('lockout', {
            principalId: null,
            ip: input.ip,
            userAgent: input.userAgent,
            details: { retry_after_ms: decision.retryAfterMs },
          });
        } else {
          log.warn('login rate limited', { ip: input.ip, retry_after_ms: decision.retryAfterMs });
        }
        throw new AppError('RATE_LIMITED', { retry_after_ms: decision.retryAfterMs });
      }
      const operator = await findOperator(deps);
      const credential =
        operator === null ? null : await findPasswordCredential(deps, operator.principalId);
      const password = input.password.reveal();
      const verified =
        operator !== null &&
        credential !== null &&
        (await deps.hasher.verify(password, credential.secretHash));
      if (!verified || operator === null || credential === null) {
        await audit.record('login_failure', {
          principalId: operator?.principalId ?? null,
          ip: input.ip,
          userAgent: input.userAgent,
          details: { reason: operator === null ? 'no_operator' : 'bad_password' },
        });
        throw new AppError('INVALID_CREDENTIALS', {});
      }
      deps.limiter.reset(input.ip);
      if (deps.hasher.needsRehash(credential.secretHash)) {
        await repos.credentials.replaceSecret(
          credential.credentialId,
          await deps.hasher.hash(password),
        );
      }
      const now = clock.now();
      const token = mintSecret(deps.random);
      deps.registerSecret?.(token);
      const session: AuthSessionRecord = {
        authSessionId: deps.ids.opaque(24),
        principalId: operator.principalId,
        tokenHash: sha256Hex(token),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + config.sessionAbsoluteMs,
        userAgent: input.userAgent ?? null,
        ip: input.ip,
        revokedAt: null,
      };
      await repos.authSessions.insert(session);
      await audit.record('login_success', {
        principalId: operator.principalId,
        ip: input.ip,
        userAgent: input.userAgent,
        details: { auth_session_id: session.authSessionId },
      });
      const principal = principalFromRecord(operator, {
        auth: {
          method: 'password-session',
          sessionId: session.authSessionId,
          expiresAt: session.expiresAt,
        },
      });
      return {
        principal,
        token: secret(token),
        cookie: {
          name: SESSION_COOKIE_NAME,
          attributes: sessionCookie('', { secure: input.secure ?? false }).attributes,
        },
        session: {
          authSessionId: session.authSessionId,
          idPrefix: idPrefix(session.authSessionId),
          expiresAt: session.expiresAt,
        },
        mustChangePassword: principal.mustChangePassword,
      };
    },

    async logout(principal, options) {
      if (isSessionPrincipal(principal)) {
        const session = await repos.authSessions.get(principal.auth.sessionId);
        if (session !== null) await revokeOne(session, 'logout', 'logout');
      }
      return clearSessionCookie({ secure: options?.secure ?? false });
    },

    async me(principal) {
      const view: MeView = {
        principal: {
          subject: principal.subject,
          kind: principal.kind,
          display: principal.display,
          scopes: principal.scopes,
          mustChangePassword: principal.mustChangePassword,
        },
      };
      if (!isSessionPrincipal(principal)) return view;
      const session = await repos.authSessions.get(principal.auth.sessionId);
      if (session === null) return view;
      return {
        ...view,
        session: {
          idPrefix: idPrefix(session.authSessionId),
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
        },
      };
    },

    async listSessions(principal) {
      const now = clock.now();
      const current = isSessionPrincipal(principal) ? principal.auth.sessionId : undefined;
      const sessions = await repos.authSessions.listActive(principal.subject);
      return sessions
        .filter((s) => isLive(s, now, config.sessionIdleMs))
        .map((s) => ({
          authSessionId: s.authSessionId,
          idPrefix: idPrefix(s.authSessionId),
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          expiresAt: s.expiresAt,
          userAgent: s.userAgent,
          ip: s.ip,
          current: s.authSessionId === current,
        }));
    },

    async revokeSession(principal, prefix) {
      const sessions = await repos.authSessions.listActive(principal.subject);
      const target = sessions.find((s) => s.authSessionId.startsWith(prefix));
      if (target === undefined) throw new AppError('NOT_FOUND', {});
      await revokeOne(target, 'operator', 'session_revoked');
    },

    async revokeAllSessions(principal) {
      const keep = isSessionPrincipal(principal) ? principal.auth.sessionId : undefined;
      const sessions = await repos.authSessions.listActive(principal.subject);
      let count = 0;
      for (const session of sessions) {
        if (session.authSessionId === keep) continue;
        if (await revokeOne(session, 'revoke_all', 'session_revoked')) count += 1;
      }
      return count;
    },

    async touchSession(authSessionId) {
      const now = clock.now();
      const session = await repos.authSessions.get(authSessionId);
      if (session === null || !isLive(session, now, config.sessionIdleMs)) return false;
      await repos.authSessions.touch(authSessionId, now);
      return true;
    },
  };
}

/** @module app/auth/auth-service — the `AuthService` facade: sessions, passwords, tokens, grants, sweeps (spec 03 §3, §4.1). */

import { type AuthAudit, createAuthAudit } from './audit.ts';
import { createGrantOps, type GrantOps } from './grant-ops.ts';
import { createPasswordOps, type PasswordOps, type PasswordOpsDeps } from './password-ops.ts';
import { createLoginRateLimiter, type LoginRateLimiter } from './rate-limit.ts';
import { createSessionOps, type SessionOps } from './session-ops.ts';
import { createTokenOps, type TokenOps } from './token-ops.ts';
import type { AuthDeps } from './types.ts';

/** Counts returned by {@link AuthService.sweep}. */
export interface SweepResult {
  readonly sessions: number;
  readonly grants: number;
  readonly rateBuckets: number;
}

/** Everything the HTTP/WS/CLI layers call for authentication state changes. */
export interface AuthService extends SessionOps, PasswordOps, TokenOps, GrantOps {
  /** The audit sink (shared with the authenticators). */
  readonly audit: AuthAudit;
  /** Prunes expired sessions and grants and stale rate buckets (schedule every 5 min). */
  sweep(): Promise<SweepResult>;
}

/** Options for {@link createAuthService}. */
export interface AuthServiceOptions extends AuthDeps {
  readonly onSeed?: PasswordOpsDeps['onSeed'];
  /** Injected for tests; built from `config` otherwise. */
  readonly limiter?: LoginRateLimiter;
  readonly audit?: AuthAudit;
}

/** Builds the {@link AuthService}. */
export function createAuthService(options: AuthServiceOptions): AuthService {
  const audit = options.audit ?? createAuthAudit(options);
  const limiter =
    options.limiter ??
    createLoginRateLimiter({
      now: () => options.clock.now(),
      maxAttempts: options.config.loginMaxAttempts,
      windowMs: options.config.loginWindowMs,
      lockoutMs: options.config.loginLockoutMs,
    });
  const deps = { ...options, audit, limiter };
  const sessions = createSessionOps(deps);
  const passwords = createPasswordOps(deps);
  const tokens = createTokenOps(deps);
  const grants = createGrantOps(deps);
  return {
    ...sessions,
    ...passwords,
    ...tokens,
    ...grants,
    audit,
    async sweep() {
      const now = options.clock.now();
      const [expiredSessions, expiredGrants] = await Promise.all([
        options.repos.authSessions.pruneExpired(now),
        options.repos.grants.pruneExpired(now),
      ]);
      return { sessions: expiredSessions, grants: expiredGrants, rateBuckets: limiter.sweep() };
    },
  };
}

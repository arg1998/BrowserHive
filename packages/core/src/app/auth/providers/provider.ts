/** @module app/auth/providers/provider — the `AuthenticationProvider` contract of the chain (spec 03 §3.2). */

import type { RequestPrincipal } from '../../../domain/auth/principal.ts';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { AuthRequestView } from '../types.ts';

/** Per-call context handed to providers. */
export interface AuthContext {
  /** `clock.now()` captured once per request so every provider agrees on the instant. */
  readonly now: number;
}

/** Provider names, in chain order. */
export type AuthProviderName = 'password-session' | 'bearer-token' | 'grant' | 'local';

/**
 * One link of the chain. Returns `null` when the request carries no credential of this kind,
 * a principal when it carries a valid one, and throws `UNAUTHORIZED` when it carries an
 * invalid one (recognized-but-invalid never falls through, D-09).
 */
export interface AuthenticationProvider {
  readonly name: AuthProviderName;
  authenticate(view: AuthRequestView, ctx: AuthContext): Promise<RequestPrincipal | null>;
}

/** Builds the `UNAUTHORIZED` error a provider throws; `reason` stays in the private message. */
export function unauthorized(provider: AuthProviderName, reason: string): AppError<'UNAUTHORIZED'> {
  return new AppError('UNAUTHORIZED', {}, { message: `${provider}: ${reason}` });
}

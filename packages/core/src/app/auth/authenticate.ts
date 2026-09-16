/** @module app/auth/authenticate — runs the provider chain: first non-null wins, present-but-invalid fails hard (D-09). */

import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import type { AuthAudit } from './audit.ts';
import type { AuthenticationProvider } from './providers/provider.ts';
import type { AuthDeps, AuthRequestView } from './types.ts';

/** The front door every transport calls. */
export interface Authenticator {
  /**
   * Resolves the caller. `null` means "no credential presented" (public routes proceed, others
   * answer 401). Throws `UNAUTHORIZED` when a credential was presented but is invalid.
   */
  authenticate(view: AuthRequestView): Promise<RequestPrincipal | null>;
  /** Like {@link Authenticator.authenticate} but a missing credential also throws `UNAUTHORIZED`. */
  require(view: AuthRequestView): Promise<RequestPrincipal>;
}

/** Options for {@link createAuthenticator}. */
export interface AuthenticatorOptions extends Pick<AuthDeps, 'clock' | 'logger'> {
  readonly providers: readonly AuthenticationProvider[];
  readonly audit: AuthAudit;
}

/** Builds an {@link Authenticator} over an ordered provider chain. */
export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
  const log = options.logger.child({ module: 'auth.chain' });
  const authenticate = async (view: AuthRequestView): Promise<RequestPrincipal | null> => {
    const ctx = { now: options.clock.now() };
    for (const provider of options.providers) {
      let principal: RequestPrincipal | null;
      try {
        principal = await provider.authenticate(view, ctx);
      } catch (error) {
        if (isAppError(error, 'UNAUTHORIZED')) {
          await options.audit.record('unauthorized', {
            principalId: null,
            ip: view.ip,
            userAgent: view.userAgent,
            details: { provider: provider.name, reason: error.message, transport: view.transport },
          });
        }
        throw error;
      }
      if (principal !== null) {
        log.debug('caller authenticated', {
          provider: provider.name,
          principal: principal.subject,
          kind: principal.kind,
        });
        return principal;
      }
    }
    return null;
  };
  return {
    authenticate,
    async require(view) {
      const principal = await authenticate(view);
      if (principal === null) {
        throw new AppError('UNAUTHORIZED', {}, { message: 'no credential presented' });
      }
      return principal;
    },
  };
}

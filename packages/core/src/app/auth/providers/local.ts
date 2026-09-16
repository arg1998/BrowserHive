/** @module app/auth/providers/local — the shared `local` principal for `auth=off` on loopback/stdio (spec 02 §1.3). */

import { LOCAL_PRINCIPAL } from '../../../domain/auth/principal.ts';
import type { AuthDeps } from '../types.ts';
import type { AuthenticationProvider } from './provider.ts';

/**
 * Yields {@link LOCAL_PRINCIPAL} only when `auth=off` and the peer is stdio or loopback (or the
 * operator acknowledged `allowInsecureBind`). Never throws; it is the last link of the MCP chain
 * and is absent from the admin chain.
 */
export function createLocalProvider(deps: Pick<AuthDeps, 'config'>): AuthenticationProvider {
  return {
    name: 'local',
    authenticate(view) {
      if (deps.config.mode !== 'off') return Promise.resolve(null);
      const allowed =
        view.transport === 'stdio' || view.remoteLoopback || deps.config.allowInsecureBind;
      return Promise.resolve(allowed ? LOCAL_PRINCIPAL : null);
    },
  };
}

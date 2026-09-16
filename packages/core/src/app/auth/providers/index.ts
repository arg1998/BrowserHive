/** @module app/auth/providers — the provider chain links and the two standard chains (admin, MCP). */

import type { AuthDeps } from '../types.ts';
import { createBearerTokenProvider } from './bearer-token.ts';
import { createGrantProvider } from './grant.ts';
import { createLocalProvider } from './local.ts';
import { createPasswordSessionProvider } from './password-session.ts';
import type { AuthenticationProvider } from './provider.ts';

export {
  type ConfigToken,
  createBearerTokenProvider,
  lookupConfigToken,
  parseConfigTokens,
} from './bearer-token.ts';
export { createGrantProvider } from './grant.ts';
export { createLocalProvider } from './local.ts';
export { createPasswordSessionProvider } from './password-session.ts';
export {
  type AuthContext,
  type AuthenticationProvider,
  type AuthProviderName,
  unauthorized,
} from './provider.ts';

/** Chain for the admin API and WS upgrade: cookie, bearer, grant. Never `local` (spec 03 §3.1). */
export function adminProviderChain(
  deps: Pick<AuthDeps, 'repos' | 'config'>,
): readonly AuthenticationProvider[] {
  return [
    createPasswordSessionProvider(deps),
    createBearerTokenProvider(deps),
    createGrantProvider(deps),
  ];
}

/** Chain for `/mcp` and stdio: bearer, then `local` under `auth=off` (spec 02 §1.3). */
export function mcpProviderChain(
  deps: Pick<AuthDeps, 'repos' | 'config'>,
): readonly AuthenticationProvider[] {
  return [createBearerTokenProvider(deps), createLocalProvider(deps)];
}

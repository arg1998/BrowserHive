/** @module composition/auth-stack — builds `AuthService` and the admin/MCP authenticators over a repository bundle (server and CLI maintenance commands share it). */

import type { AuthMode } from '@browserhive/contracts/enums';
import type {
  AuthDeps,
  AuthEvents,
  Authenticator,
  AuthService,
  Clock,
  DomainEvents,
  EventBus,
  IdGenerator,
  Logger,
  Repositories,
} from '@browserhive/core/runtime';
import {
  AUTH_EVENT_TYPES,
  adminProviderChain,
  createAuthAudit,
  createAuthenticator,
  createAuthService,
  createBunPasswordHasher,
  createCredentialsFile,
  createWebCryptoRandom,
  mcpProviderChain,
  resolveAuthConfig,
} from '@browserhive/core/runtime';

/**
 * Grant reuse window: the Playwright trace viewer issues HEAD plus ranged GETs for one
 * `trace.zip`, so a grant stays valid for this long after its first use (build-core-auth paradox).
 */
export const GRANT_REUSE_WINDOW_MS = 30_000;

/** Inputs of {@link createAuthStack}. */
export interface AuthStackInput {
  readonly repos: Pick<
    Repositories,
    'principals' | 'credentials' | 'authSessions' | 'grants' | 'authEvents'
  >;
  readonly dataDir: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly mode: AuthMode;
  readonly authTokens: readonly string[];
  readonly allowInsecureBind: boolean;
  readonly bus?: EventBus<DomainEvents>;
  /** Adds literals to the redaction registry (seed password, grants). */
  readonly registerSecret?: (literal: string) => void;
}

/** The built auth stack. */
export interface AuthStack {
  readonly service: AuthService;
  readonly admin: Authenticator;
  readonly mcp: Authenticator;
}

/** Builds the auth stack (Argon2id hasher, CSPRNG, `<dataDir>/admin/credentials.txt`). */
export function createAuthStack(input: AuthStackInput): AuthStack {
  const deps: AuthDeps = {
    repos: input.repos,
    clock: input.clock,
    ids: input.ids,
    random: createWebCryptoRandom(),
    hasher: createBunPasswordHasher(),
    credentialsFile: createCredentialsFile({ dataDir: input.dataDir }),
    logger: input.logger,
    config: resolveAuthConfig({
      mode: input.mode,
      authTokens: input.authTokens,
      allowInsecureBind: input.allowInsecureBind,
      grantReuseWindowMs: GRANT_REUSE_WINDOW_MS,
    }),
    ...(input.bus !== undefined && { bus: authBusOf(input.bus) }),
    ...(input.registerSecret !== undefined && { registerSecret: input.registerSecret }),
  };
  const audit = createAuthAudit(deps);
  return {
    service: createAuthService({ ...deps, audit }),
    admin: createAuthenticator({ ...deps, audit, providers: adminProviderChain(deps) }),
    mcp: createAuthenticator({ ...deps, audit, providers: mcpProviderChain(deps) }),
  };
}

/**
 * The auth subsystem's view of the domain bus. `EventBus<DomainEvents>` is not assignable to
 * `EventBus<AuthEvents>` (handler variance), so the narrow view delegates per name.
 */
export function authBusOf(bus: EventBus<DomainEvents>): EventBus<AuthEvents> {
  return {
    publish: (name, payload) => bus.publish(name, payload),
    subscribe: (name, handler) => bus.subscribe(name, handler),
    subscribeAll: (handler) => {
      const offs = AUTH_EVENT_TYPES.map((type) => bus.subscribe(`auth.${type}`, handler));
      return () => {
        for (const off of offs) off();
      };
    },
  };
}

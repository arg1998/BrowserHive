/** @module app/auth/types — request view, configuration and dependencies shared by the auth services (D-09). */

import type { AuthMode } from '@browserhive/contracts/enums';
import type { GrantRoute } from '@browserhive/contracts/http';
import type { Clock } from '../../ports/clock.ts';
import type { CredentialsFile } from '../../ports/credentials-file.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { PasswordHasher } from '../../ports/password-hasher.ts';
import type {
  AuthEventRepository,
  AuthSessionRepository,
  CredentialRepository,
  GrantRepository,
  PrincipalRepository,
} from '../../ports/persistence/identity.ts';
import type { Random } from '../../ports/random.ts';
import type { AuthEvents } from './events.ts';

/** Transport that built the view. */
export type AuthTransport = 'http' | 'stdio' | 'ws';

/**
 * Everything the provider chain needs from an inbound request. The HTTP, WS and MCP layers build
 * it; no framework type crosses into the app layer.
 */
export interface AuthRequestView {
  readonly headers: {
    /** Raw `Authorization` header. */
    readonly authorization?: string;
    /** Raw `Cookie` header. */
    readonly cookie?: string;
  };
  readonly query: {
    /** `?grant=<token>`; only honoured when {@link AuthRequestView.grantRoute} is set. */
    readonly grant?: string;
  };
  readonly transport: AuthTransport;
  /** True for stdio and for HTTP peers on a loopback address (after trusted-proxy resolution). */
  readonly remoteLoopback: boolean;
  /** Client IP after trusted-proxy resolution; absent under stdio. */
  readonly ip?: string;
  readonly userAgent?: string;
  /** Set by grant-enabled routes only (`trace.zip`, screenshot images): what the grant must match. */
  readonly grantRoute?: { readonly route: GrantRoute; readonly resourceId: string };
}

/** Auth tunables; defaults are the spec 03 §2/§3.3 values. */
export interface AuthConfig {
  /** `auth` config key. */
  readonly mode: AuthMode;
  /** `authTokens` config key (`name:token` items), hashed into memory at boot, never persisted. */
  readonly authTokens: readonly string[];
  /** `allowInsecureBind`: with `mode='off'` the local principal is also served to non-loopback peers. */
  readonly allowInsecureBind: boolean;
  /** Operator session idle timeout (15 min). */
  readonly sessionIdleMs: number;
  /** Operator session absolute lifetime (8 h). */
  readonly sessionAbsoluteMs: number;
  /** Grant lifetime (10 min). */
  readonly grantTtlMs: number;
  /** After first use a grant stays valid this long (0 = strictly single-use). */
  readonly grantReuseWindowMs: number;
  /** Login attempts per window per IP before lockout (5). */
  readonly loginMaxAttempts: number;
  /** Login window (60 s). */
  readonly loginWindowMs: number;
  /** Lockout after the window is exceeded (5 min). */
  readonly loginLockoutMs: number;
}

/** Spec defaults for {@link AuthConfig}. */
export const DEFAULT_AUTH_CONFIG: AuthConfig = Object.freeze({
  mode: 'off',
  authTokens: [],
  allowInsecureBind: false,
  sessionIdleMs: 15 * 60 * 1000,
  sessionAbsoluteMs: 8 * 60 * 60 * 1000,
  grantTtlMs: 10 * 60 * 1000,
  grantReuseWindowMs: 0,
  loginMaxAttempts: 5,
  loginWindowMs: 60 * 1000,
  loginLockoutMs: 5 * 60 * 1000,
});

/** Merges overrides onto {@link DEFAULT_AUTH_CONFIG}. */
export function resolveAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return { ...DEFAULT_AUTH_CONFIG, ...overrides };
}

/** The five identity repositories (a subset of `Repositories`). */
export interface AuthRepositories {
  readonly principals: PrincipalRepository;
  readonly credentials: CredentialRepository;
  readonly authSessions: AuthSessionRepository;
  readonly grants: GrantRepository;
  readonly authEvents: AuthEventRepository;
}

/** Dependencies of every auth service and provider. */
export interface AuthDeps {
  readonly repos: AuthRepositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly hasher: PasswordHasher;
  readonly credentialsFile: CredentialsFile;
  readonly logger: Logger;
  readonly config: AuthConfig;
  /** Domain event bus; optional so unit tests and the CLI can omit it. */
  readonly bus?: EventBus<AuthEvents>;
  /** Registers a freshly minted secret with the redaction registry (spec 10 §9). */
  readonly registerSecret?: (literal: string) => void;
}

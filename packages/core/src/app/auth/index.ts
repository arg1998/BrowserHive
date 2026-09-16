/** @module app/auth — authentication services: provider chain, authenticator, `AuthService`, audit and rate limiting. */

export { type AuditInput, type AuthAudit, createAuthAudit } from './audit.ts';
export {
  type AuthService,
  type AuthServiceOptions,
  createAuthService,
  type SweepResult,
} from './auth-service.ts';
export {
  type Authenticator,
  type AuthenticatorOptions,
  createAuthenticator,
} from './authenticate.ts';
export {
  type AuthEventName,
  type AuthEventPayload,
  type AuthEvents,
  authEventName,
} from './events.ts';
export {
  type CreateGrantInput,
  type CreateGrantResult,
  createGrantOps,
  type GrantOps,
} from './grant-ops.ts';
export {
  ADMIN_PRINCIPAL_ID,
  createPasswordOps,
  type PasswordOps,
  type PasswordOpsDeps,
  type SeedResult,
} from './password-ops.ts';
export {
  type AuthContext,
  type AuthenticationProvider,
  type AuthProviderName,
  adminProviderChain,
  type ConfigToken,
  createBearerTokenProvider,
  createGrantProvider,
  createLocalProvider,
  createPasswordSessionProvider,
  lookupConfigToken,
  mcpProviderChain,
  parseConfigTokens,
  unauthorized,
} from './providers/index.ts';
export {
  createLoginRateLimiter,
  type LoginRateLimiter,
  type LoginRateLimiterOptions,
  type RateDecision,
} from './rate-limit.ts';
export {
  type AuthSessionView,
  createSessionOps,
  findOperator,
  findPasswordCredential,
  type LoginInput,
  type LoginResult,
  type MeView,
  type SessionOps,
} from './session-ops.ts';
export {
  type ApiTokenView,
  type CreateTokenInput,
  type CreateTokenResult,
  createTokenOps,
  SEED_AGENT_PRINCIPAL_ID,
  type SeedTokenResult,
  type TokenOps,
} from './token-ops.ts';
export {
  type AuthConfig,
  type AuthDeps,
  type AuthRepositories,
  type AuthRequestView,
  type AuthTransport,
  DEFAULT_AUTH_CONFIG,
  resolveAuthConfig,
} from './types.ts';

/** @module composition/auth-stack — builds `AuthService` and the admin/MCP authenticators over a repository bundle (server and CLI maintenance commands share it). */
import type { AuthMode } from '@browserhive/contracts/enums';
import type {
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
/**
 * Grant reuse window: the Playwright trace viewer issues HEAD plus ranged GETs for one
 * `trace.zip`, so a grant stays valid for this long after its first use (build-core-auth paradox).
 */
export declare const GRANT_REUSE_WINDOW_MS = 30000;
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
export declare function createAuthStack(input: AuthStackInput): AuthStack;
/**
 * The auth subsystem's view of the domain bus. `EventBus<DomainEvents>` is not assignable to
 * `EventBus<AuthEvents>` (handler variance), so the narrow view delegates per name.
 */
export declare function authBusOf(bus: EventBus<DomainEvents>): EventBus<AuthEvents>;
//# sourceMappingURL=auth-stack.d.ts.map

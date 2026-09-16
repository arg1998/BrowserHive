/** @module app/sessions/service-deps — the SessionService constructor dependency record and the config keys it consumes. */

import type {
  Channel,
  PersistenceMode,
  StealthDriver,
  StealthLevel,
} from '@browserhive/contracts/enums';
import type { Tracer } from '@opentelemetry/api';
import type { AdmissionPolicy, MaxSessions } from '../../domain/session/admission.ts';
import type { AuthStateLocator } from '../../ports/auth-state-locator.ts';
import type { BrowserDriver } from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventBus } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { IdentityResolver } from '../../ports/identity-resolver.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ProxyResolver } from '../../ports/proxy-resolver.ts';
import type { SessionPolicyInstaller } from '../../ports/session-policies.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { SessionDirFs } from './profile-dir.ts';

/** The `ServerConfig` keys the service consumes (camelCase, resolved values). */
export interface SessionServiceConfig {
  readonly dataDir: string;
  readonly sessionLease: number;
  readonly sessionCloseTimeout: number;
  readonly defaultHeadless: boolean;
  readonly defaultChannel: Channel;
  readonly persistence: PersistenceMode;
  readonly maxSessions: MaxSessions;
  readonly stealth: StealthLevel;
  readonly stealthDriver: StealthDriver;
  readonly fingerprint: boolean;
  readonly humanize: boolean;
  readonly trace: boolean;
  readonly screenshotTrace: boolean;
}

/** Constructor dependencies of {@link SessionService}. */
export interface SessionServiceDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly bus: EventBus<DomainEvents>;
  readonly driver: BrowserDriver;
  readonly proxyResolver: ProxyResolver;
  readonly config: SessionServiceConfig;
  /** Required when any session may request a fingerprint; adapted from `infra/browsers` at composition. */
  readonly identityResolver?: IdentityResolver;
  /** Installs the blocklist route (and later interception policies); omit for a hive without a blocklist. */
  readonly policies?: SessionPolicyInstaller;
  /** Saved auth snapshots; omitting it makes every `restore_profile`/`storageState` name `AUTH_STATE_NOT_FOUND`. */
  readonly authStates?: AuthStateLocator;
  /** Defaults to a fixed cap over `config.maxSessions`. */
  readonly admission?: AdmissionPolicy;
  /** Defaults to `node:fs/promises`. */
  readonly fs?: SessionDirFs;
  /** Defaults to `trace.getTracer('browserhive')`. */
  readonly tracer?: Tracer;
}

/** Facts for `server_status` and the System page. */
export interface SessionServerStatus {
  readonly count: number;
  readonly limit: number | null;
  readonly driver: 'patchright' | 'playwright';
  readonly persistenceMode: PersistenceMode;
}

/** @module app/sessions/pipeline-deps — the dependency record and hook set the creation pipeline runs on. */

import type { ClosedReason, StealthDriver } from '@browserhive/contracts/enums';
import type { Tracer } from '@opentelemetry/api';
import type { AdmissionPolicy } from '../../domain/session/admission.ts';
import type { CreateSessionInput, SessionDefaults } from '../../domain/session/create-request.ts';
import type { SessionPrincipal } from '../../domain/session/principal.ts';
import type { Session } from '../../domain/session/session.ts';
import type { SessionWarning } from '../../domain/session/warnings.ts';
import type { AuthStateLocator } from '../../ports/auth-state-locator.ts';
import type { BrowserDriver, ProxySpec } from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { IdentityResolver } from '../../ports/identity-resolver.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ProxyResolver } from '../../ports/proxy-resolver.ts';
import type { SessionPolicyInstaller } from '../../ports/session-policies.ts';
import type { SessionDirFs, SessionDirLayout } from './profile-dir.ts';
import type { SessionRegistry } from './registry.ts';

/** Everything one pipeline run needs (built per call by `SessionService.create`). */
export interface PipelineDeps {
  readonly input: CreateSessionInput;
  readonly principal: SessionPrincipal;
  readonly defaults: SessionDefaults;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly driver: BrowserDriver;
  readonly proxyResolver: ProxyResolver;
  readonly identityResolver: IdentityResolver | undefined;
  readonly policies: SessionPolicyInstaller | undefined;
  readonly authStates: AuthStateLocator | undefined;
  readonly admission: AdmissionPolicy;
  readonly registry: SessionRegistry;
  readonly layout: SessionDirLayout;
  readonly fs: SessionDirFs;
  readonly leaseWindowMs: number;
  readonly trace: boolean;
  readonly screenshotTrace: boolean;
  readonly closeTimeoutMs: number;
  readonly stealthDriver: StealthDriver;
}

/** Callbacks into the service so the pipeline never publishes or logs on its own. */
export interface PipelineHooks {
  /** The session was reserved (publish `session.opened`). */
  opened(session: Session): void;
  /** State or facts changed (publish `session.updated`). */
  updated(session: Session): void;
  /** A warning was raised (append, log, publish `session.warning`). */
  warn(session: Session, warning: SessionWarning): void;
  /** The proxy decision is in (publish `session.proxy_assigned`). */
  proxyAssigned(session: Session, proxy: ProxySpec | null): void;
  /** The driver reported a crash. */
  crashed(session: Session, reason: string): void;
  /** The pipeline failed after reserve; the session is finalized as `closed(reason)`. */
  closed(session: Session, reason: ClosedReason, at: number): void;
}

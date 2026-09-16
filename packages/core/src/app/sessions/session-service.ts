/** @module app/sessions/session-service — SessionService: create (D-21 pipeline), the one ownership check, lease control, close/closeAll, tabs, warnings, projections. */

import type { ClosedReason } from '@browserhive/contracts/enums';
import type { SessionSummary } from '@browserhive/contracts/http';
import { type Tracer, trace } from '@opentelemetry/api';
import type { Page } from 'playwright';
import { type AdmissionPolicy, CapAdmissionPolicy } from '../../domain/session/admission.ts';
import {
  type CreateSessionInput,
  type SessionDefaults,
  sessionDefaultsFromConfig,
} from '../../domain/session/create-request.ts';
import { ownsSession, type SessionPrincipal } from '../../domain/session/principal.ts';
import type { Session, SessionCounter } from '../../domain/session/session.ts';
import { canServeTools, type PauseReason } from '../../domain/session/state.ts';
import type { SessionWarning } from '../../domain/session/warnings.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import { type CreateOptions, type PhaseTiming, runCreatePipeline } from './create-pipeline.ts';
import type { LeaseController } from './lease-controller.ts';
import { type SessionMetadataWithDriver, toSessionMetadata, toSessionSummary } from './metadata.ts';
import type { PipelineHooks } from './pipeline-deps.ts';
import { createNodeSessionDirFs, type SessionDirFs, sessionDirLayout } from './profile-dir.ts';
import { SessionRegistry } from './registry.ts';
import type { SessionServerStatus, SessionServiceDeps } from './service-deps.ts';
import { type CloseOptions, closeSession } from './session-close.ts';
import { subscribeSessionCounters } from './session-counters.ts';
import { SessionPublisher } from './session-publisher.ts';
import { SessionTabs, type TabInfo } from './session-tabs.ts';

/** Default budget for one `create` (validate through register). */
export const DEFAULT_CREATE_DEADLINE_MS = 90_000;

/**
 * The application service every tool, route and broker goes through for sessions. Owns the
 * registry, the lease sweeper's inputs, and every `session.*` event.
 */
export class SessionService {
  readonly registry = new SessionRegistry();
  /** Narrow pause/resume surface for the operator-request broker. */
  readonly lease: LeaseController;
  private readonly deps: SessionServiceDeps;
  private readonly defaults: SessionDefaults;
  private readonly admission: AdmissionPolicy;
  private readonly fs: SessionDirFs;
  private readonly tracer: Tracer;
  private readonly layout;
  private readonly log: Logger;
  private readonly tabs: SessionTabs;
  private readonly hooks: PipelineHooks;
  private readonly publisher: SessionPublisher;
  private lastTimings: readonly PhaseTiming[] = [];

  constructor(deps: SessionServiceDeps) {
    this.deps = deps;
    this.defaults = sessionDefaultsFromConfig(deps.config);
    this.admission = deps.admission ?? new CapAdmissionPolicy(deps.config.maxSessions);
    this.fs = deps.fs ?? createNodeSessionDirFs();
    this.tracer = deps.tracer ?? trace.getTracer('browserhive');
    this.layout = sessionDirLayout(deps.config.dataDir);
    this.log = deps.logger.child({ module: 'sessions.lifecycle' });
    this.tabs = new SessionTabs({ clock: deps.clock, logger: this.log });
    this.publisher = new SessionPublisher({ bus: deps.bus, clock: deps.clock, logger: this.log });
    this.lease = {
      pause: (id, at, reason) => this.pauseLease(id, at, reason ?? 'attention'),
      resume: (id, at) => this.resumeLease(id, at),
    };
    this.hooks = {
      opened: (session) => this.publisher.opened(session),
      updated: (session) => this.publisher.updated(session),
      warn: (session, warning) => this.publisher.warn(session, warning),
      proxyAssigned: (session, proxy) => this.publisher.proxyAssigned(session, proxy),
      crashed: (session, reason) => this.onCrash(session, reason),
      closed: (session, reason, at) => this.publisher.closed(session, reason, at),
    };
    subscribeSessionCounters(deps.bus, this);
  }

  // --- lifecycle ---------------------------------------------------------------------------------

  /**
   * Runs the D-21 pipeline and returns the live session. Throws the typed launch errors
   * (`INVALID_SLUG`, `UNKNOWN_CHANNEL`, `SESSION_LIMIT_REACHED`, `SESSION_ALREADY_EXISTS`,
   * `UNSAFE_LAUNCH_ARG`, `INVALID_PERSISTENCE_CONFIG`, `AUTH_STATE_NOT_FOUND`,
   * `BROWSER_NOT_INSTALLED`, `WAIT_TIMEOUT` on deadline).
   */
  async create(
    input: CreateSessionInput,
    principal: SessionPrincipal,
    options: Partial<CreateOptions> = {},
  ): Promise<Session> {
    const create: CreateOptions = {
      ...(options.signal !== undefined && { signal: options.signal }),
      deadlineMs: options.deadlineMs ?? DEFAULT_CREATE_DEADLINE_MS,
    };
    return this.tracer.startActiveSpan('session.create', async (span) => {
      try {
        const outcome = await runCreatePipeline(
          this.pipelineDeps(input, principal),
          this.hooks,
          create,
        );
        this.lastTimings = outcome.timings;
        span.setAttribute('browserhive.session_id', outcome.session.id);
        this.log.info('session opened', {
          sessionId: outcome.session.id,
          owner: principal.subject,
          channel: outcome.session.request.channel,
          launch_ms: outcome.session.launchMs,
        });
        return outcome.session;
      } finally {
        span.end();
      }
    });
  }

  /** Phase timings of the most recent `create` (tests and the launch span). */
  get timings(): readonly PhaseTiming[] {
    return this.lastTimings;
  }

  /**
   * The ONE ownership check. Resets the sliding lease and stamps `lastToolAt`.
   *
   * @throws `SESSION_NOT_FOUND` for an unknown id; `SESSION_ACCESS_DENIED` (byte-identical message,
   *   so a cross-principal probe learns nothing) for another principal's session; `SESSION_DEAD`
   *   once the browser crashed; `SESSION_NOT_AVAILABLE` while launching or draining.
   */
  get(sessionId: string, principal: SessionPrincipal): Session {
    const session = this.registry.get(sessionId);
    if (session === undefined) throw notFound('SESSION_NOT_FOUND', sessionId);
    if (!ownsSession(principal, session.owner)) throw notFound('SESSION_ACCESS_DENIED', sessionId);
    if (session.dead) {
      throw new AppError(
        'SESSION_DEAD',
        { session_id: sessionId },
        {
          publicMessage: `Session '${sessionId}' is dead — its underlying browser process crashed.`,
        },
      );
    }
    if (!canServeTools(session.state)) {
      throw new AppError(
        'SESSION_NOT_AVAILABLE',
        { session_id: sessionId, state: session.state.kind },
        {
          publicMessage: `Session '${sessionId}' is not available (state: ${session.state.kind}).`,
        },
      );
    }
    session.touch(this.deps.clock.now(), this.deps.config.sessionLease);
    return session;
  }

  /** Looks a session up without ownership, lease or liveness checks (operator routes, sweeper). */
  peek(sessionId: string): Session | undefined {
    return this.registry.get(sessionId);
  }

  /** The caller's sessions only (`list_sessions` fix, D-12). */
  list(principal: SessionPrincipal): readonly Session[] {
    return this.registry.ownedBy(principal.subject);
  }

  /** Every session occupying capacity (admin views). */
  listAll(): readonly Session[] {
    return this.registry.values();
  }

  /**
   * Closes and forgets a session. Idempotent: `false` when the id is unknown or already closing.
   * Settles through events: `session.closed` is what the operator-request broker, WS and recorder
   * react to. Never throws.
   */
  async close(
    sessionId: string,
    reason: ClosedReason = 'user',
    options: CloseOptions = {},
  ): Promise<boolean> {
    return closeSession(sessionId, reason, options, {
      registry: this.registry,
      clock: this.deps.clock,
      logger: this.log,
      tracer: this.tracer,
      fs: this.fs,
      layout: this.layout,
      closeTimeoutMs: this.deps.config.sessionCloseTimeout,
      updated: (s) => this.publisher.updated(s),
      warn: (s, w) => this.warn(s, w),
      closed: (s, r, at) => this.publisher.closed(s, r, at),
    });
  }

  /** Best-effort shutdown: closes every session concurrently within `deadlineMs` each. */
  async closeAll(reason: ClosedReason = 'shutdown', deadlineMs?: number): Promise<void> {
    const ids = this.registry.values().map((s) => s.id);
    await Promise.allSettled(
      ids.map((id) => this.close(id, reason, deadlineMs === undefined ? {} : { deadlineMs })),
    );
  }

  // --- lease ---------------------------------------------------------------------------------------

  private pauseLease(sessionId: string, at: number, reason: PauseReason): void {
    const session = this.registry.get(sessionId);
    if (session === undefined || session.state.kind !== 'live') return;
    session.apply({ type: 'pause', reason, at });
    session.pauseLease(at);
    this.publisher.updated(session);
  }

  private resumeLease(sessionId: string, at: number): void {
    const session = this.registry.get(sessionId);
    if (session === undefined || session.state.kind !== 'paused') return;
    session.apply({ type: 'resume', at });
    session.resumeLease(at);
    this.publisher.updated(session);
  }

  // --- tabs and pages ------------------------------------------------------------------------------

  /** The page for `tabId`, or the active tab. @throws `TAB_NOT_FOUND`. */
  page(session: Session, tabId?: string): Page {
    return session.tabs.resolve(tabId);
  }

  /** Every open page in tab order. */
  pages(session: Session): readonly Page[] {
    return session.tabs.entries().map(([, page]) => page);
  }

  /** Opens a new tab (identity override awaited first) and makes it active. */
  newTab(session: Session): Promise<{ tabId: string; page: Page }> {
    return this.tabs.newTab(session);
  }

  /** Closes a tab. @throws `TAB_NOT_FOUND`. */
  closeTab(session: Session, tabId: string): Promise<void> {
    return this.tabs.closeTab(session, tabId);
  }

  /** Makes `tabId` active. @throws `TAB_NOT_FOUND`. */
  switchTab(session: Session, tabId: string): Page {
    return this.tabs.switchTab(session, tabId);
  }

  /** `list_tabs` rows in insertion order (`title` is `''` on failure). */
  listTabs(session: Session): Promise<readonly TabInfo[]> {
    return this.tabs.listTabs(session);
  }

  // --- facts ---------------------------------------------------------------------------------------

  /** Records the URL a tool observed and publishes `session.updated`. */
  setCurrentUrl(session: Session, url: string | null): void {
    session.setCurrentUrl(url, this.deps.clock.now());
    this.publisher.updated(session);
  }

  /**
   * Applies `delta` to one counter of a registered session and broadcasts `session.updated` so
   * list rows, the detail header and the takeover gate see live counts. Unknown ids are ignored.
   */
  bumpCounter(sessionId: string, counter: SessionCounter, delta: number): void {
    const session = this.registry.get(sessionId);
    if (session === undefined) return;
    session.bump(counter, delta);
    this.publisher.updated(session);
  }

  /** Appends a warning, logs it at `warn`, and broadcasts `session.warning`. */
  warn(session: Session, warning: SessionWarning): void {
    this.publisher.warn(session, warning);
  }

  /** The `launch_session`/`list_sessions` wire shape. */
  metadata(session: Session): SessionMetadataWithDriver {
    return toSessionMetadata(session);
  }

  /** The HTTP/WS `SessionSummary`. */
  summary(session: Session): SessionSummary {
    return toSessionSummary(session, this.deps.clock.now());
  }

  /** Facts for `server_status`. */
  serverStatus(): SessionServerStatus {
    return {
      count: this.registry.liveCount(),
      limit: this.admission.capacity(),
      driver: this.deps.driver.stealthDriverName(),
      persistenceMode: this.deps.config.persistence,
    };
  }

  // --- internals ---------------------------------------------------------------------------------

  private pipelineDeps(input: CreateSessionInput, principal: SessionPrincipal) {
    const d = this.deps;
    return {
      input,
      principal,
      defaults: this.defaults,
      clock: d.clock,
      ids: d.ids,
      logger: d.logger,
      tracer: this.tracer,
      driver: d.driver,
      proxyResolver: d.proxyResolver,
      identityResolver: d.identityResolver,
      policies: d.policies,
      authStates: d.authStates,
      admission: this.admission,
      registry: this.registry,
      layout: this.layout,
      fs: this.fs,
      leaseWindowMs: d.config.sessionLease,
      trace: d.config.trace,
      screenshotTrace: d.config.screenshotTrace,
      closeTimeoutMs: d.config.sessionCloseTimeout,
      stealthDriver: d.config.stealthDriver,
    };
  }

  private onCrash(session: Session, reason: string): void {
    const at = this.deps.clock.now();
    const wasUsable = canServeTools(session.state);
    const result = session.tryApply({ type: 'crash', detail: reason, at });
    if (!result.ok) return;
    this.log.warn('session crashed', { sessionId: session.id, reason });
    this.publisher.updated(session);
    // Reap immediately rather than at the next sweep; the sweeper remains the backstop.
    if (wasUsable) {
      void this.close(session.id, 'crash').catch((err: unknown) => {
        this.warn(session, {
          code: 'REAP_DEAD_FAILED',
          sessionId: session.id,
          message: 'failed to reap a session after its browser disconnected out-of-band',
          details: { error: serializeError(err) },
        });
      });
    }
  }
}

function notFound(
  code: 'SESSION_NOT_FOUND' | 'SESSION_ACCESS_DENIED',
  sessionId: string,
): AppError {
  // `SESSION_ACCESS_DENIED` mirrors `SESSION_NOT_FOUND` text so a caller cannot probe for sessions it does not own.
  return new AppError(
    code,
    { session_id: sessionId },
    { publicMessage: `No browser session with id '${sessionId}'` },
  );
}

/** @module app/templates/host-lifecycle — one template's host through its states (spec 13 §3.2): lazy start with a reserved browser slot, joining a start in progress, crash fan-out with backoff restarts, `failed` after five failures, operator stop, drain and clean stop. */

import type { ClosedReason } from '@browserhive/contracts/enums';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type {
  TemplateHost,
  TemplateHostExit,
  TemplateHostLauncher,
  TemplateHostSpec,
} from '../../ports/template-host.ts';
import {
  FailureWindow,
  HEALTHY_RUN_MS,
  HOST_START_DEADLINE_MS,
  type HostFailure,
  type HostState,
  holdsSlot,
  MAX_FAILURES,
  permanentFailure,
} from './host-state.ts';
import { templateNeedsOperator, templateUnavailable } from './template-admission.ts';

/** What one lifecycle needs from the supervisor. */
export interface HostLifecycleDeps {
  readonly launcher: TemplateHostLauncher;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly degradations: DegradationReporter;
  readonly buildSpec: (template: TemplateRecord) => Promise<TemplateHostSpec>;
  /** A host came up (record the observed identity, reset idle clocks). */
  readonly started: (template: TemplateRecord, host: TemplateHost) => void;
  /** Closes sessions of the template with `reason` (operator stop, drain timeout). */
  readonly closeSessions: (ids: readonly string[], reason: ClosedReason) => Promise<void>;
  /** A slot is free for a restart that was not reserved under the registry lock. */
  readonly slotFree: () => boolean;
  /**
   * Runs on a clean stop after the sessions closed and before the browser closes: the final
   * checkpoint (spec 13 §3.2 idle stop, §3.9). Never throws.
   */
  readonly beforeClose?: (host: TemplateHost) => Promise<void>;
  /** The host changed state (the `template.host` event). */
  readonly changed?: (templateId: string) => void;
  readonly closeTimeoutMs: number;
}

/** The host of one template. */
export class HostLifecycle {
  readonly templateId: string;
  state: HostState = 'stopped';
  since: number | null = null;
  startedAt: number | null = null;
  restarts = 0;
  /** Operator-facing cause of `failed` / `crashed`. */
  lastError: string | null = null;
  failure: HostFailure | null = null;
  /** When a crashed host restarts. */
  restartAt: number | null = null;
  idleSince: number | null = null;
  /** Saved passwords or autofill data were found at the last start (spec 13 §3.1). */
  profileSecrets = false;
  private template: TemplateRecord;
  private instance: TemplateHost | null = null;
  private starting: Promise<TemplateHost> | null = null;
  private readonly failures = new FailureWindow();
  private restartTimer: AbortController | null = null;
  private offExit: (() => void) | null = null;
  private readonly deps: HostLifecycleDeps;
  private readonly log: Logger;

  constructor(template: TemplateRecord, deps: HostLifecycleDeps) {
    this.templateId = template.templateId;
    this.template = template;
    this.deps = deps;
    this.log = deps.logger.child({ module: 'templates.host', templateId: template.templateId });
  }

  /** The running host, or `null`. */
  get running(): TemplateHost | null {
    return this.state === 'running' ? this.instance : null;
  }

  /** The current host whatever its state (draining included), or `null`. */
  get current(): TemplateHost | null {
    return this.instance;
  }

  get holdsSlot(): boolean {
    return holdsSlot(this.state);
  }

  /** Keeps the newest template row (name, identity) for later starts. */
  refresh(template: TemplateRecord): void {
    this.template = template;
  }

  /**
   * Under the registry lock: a stopped host is marked `starting` after `admitSlot` passed (it
   * throws `SESSION_LIMIT_REACHED`). Returns the compensator that gives back a reservation whose
   * start never began.
   */
  reserve(admitSlot: () => void): () => void {
    if (this.state !== 'stopped') return () => undefined;
    admitSlot();
    this.enter('starting');
    return () => {
      if (this.state === 'starting' && this.starting === null) this.enter('stopped');
    };
  }

  /**
   * The running host: starts it (after `reserve`) or joins the start in progress, within `signal`.
   * When the budget runs out first the launch answers `TEMPLATE_UNAVAILABLE` `starting` and the
   * start continues (spec 13 §3.7).
   */
  async acquire(signal: AbortSignal): Promise<TemplateHost> {
    if (this.state === 'running' && this.instance !== null) return this.instance;
    if (this.state === 'starting') {
      const start = this.starting ?? this.launch();
      return raceBudget(start, signal, this.template.name, () => this.refusal());
    }
    throw this.refusal();
  }

  /** The typed refusal for a host that cannot take a launch now. */
  refusal(): Error {
    const name = this.template.name;
    if (this.state === 'failed') return templateNeedsOperator(name);
    if (this.state === 'crashed') {
      const wait = this.restartAt === null ? undefined : this.restartAt - this.deps.clock.now();
      return templateUnavailable(name, 'recovering', wait);
    }
    if (this.state === 'draining') return templateUnavailable(name, 'restarting');
    return templateUnavailable(name, 'starting');
  }

  /**
   * Stops the host cleanly (idle stop, after a drain, delete, daemon shutdown). The host is
   * `draining` until its browser is closed, so a launch meanwhile is refused typed
   * (`TEMPLATE_UNAVAILABLE` `restarting`) and never attaches to a closing browser, and no new start
   * can race the old one for the profile lock. Every session still on the host is closed with
   * `closeReason` first, and again after the close for a view that opened in between.
   */
  async stop(
    reason: string,
    closeReason: ClosedReason = 'shutdown',
    checkpoint = true,
  ): Promise<void> {
    this.cancelRestart();
    const host = this.instance;
    const starting = this.starting;
    this.enter(host !== null || starting !== null ? 'draining' : 'stopped');
    if (host !== null) {
      await this.deps.closeSessions(host.viewIds(), closeReason);
      if (checkpoint) await this.deps.beforeClose?.(host).catch(() => undefined);
      this.log.info('template host stopped', { reason });
      this.detach();
      await host.close(this.deps.closeTimeoutMs);
      const late = host.viewIds();
      if (late.length > 0) await this.deps.closeSessions(late, closeReason);
    } else if (starting !== null) {
      this.detach();
      // A start in flight: close what it brings up.
      await starting.then((up) => up.close(this.deps.closeTimeoutMs)).catch(() => undefined);
    }
    this.startedAt = null;
    this.enter('stopped');
  }

  /**
   * Refuses new launches, waits up to `timeoutMs` for `liveSessions()` to finish, force-closes the
   * rest with `closeReason`, then stops (spec 13 §3.2 recycle).
   */
  async drain(
    liveSessions: () => readonly string[],
    timeoutMs: number,
    closeReason: ClosedReason,
  ): Promise<void> {
    if (this.state !== 'running') return;
    this.enter('draining');
    const until = this.deps.clock.now() + timeoutMs;
    while (liveSessions().length > 0 && this.deps.clock.now() < until && this.is('draining')) {
      await this.deps.clock.sleep(Math.min(1_000, until - this.deps.clock.now()));
    }
    const left = liveSessions();
    if (left.length > 0) await this.deps.closeSessions(left, closeReason);
    if (this.is('draining')) await this.stop('drained');
  }

  /** The state, read afresh (it changes across awaits; TypeScript narrows too eagerly). */
  private is(state: HostState): boolean {
    return this.state === state;
  }

  /** An operator restart clears `failed` and the failure window (spec 13 §3.2). */
  clearFailure(): void {
    this.failures.clear();
    this.failure = null;
    if (this.state === 'failed') this.enter('stopped');
  }

  private launch(): Promise<TemplateHost> {
    const started = this.deps.clock.now();
    const run = (async () => {
      const spec = await this.deps.buildSpec(this.template);
      return withStartDeadline(this.deps.launcher.launchTemplateHost(spec), this.deps.clock);
    })();
    this.starting = run;
    run.then(
      (host) => this.onStarted(run, host, started),
      (err: unknown) => this.onStartFailed(run, err),
    );
    return run;
  }

  private onStarted(run: Promise<TemplateHost>, host: TemplateHost, began: number): void {
    if (this.starting !== run || this.state !== 'starting') {
      // Stopped meanwhile: the late host is closed by `stop`.
      return;
    }
    this.starting = null;
    this.instance = host;
    this.startedAt = this.deps.clock.now();
    this.idleSince = null;
    this.lastError = null;
    this.profileSecrets = host.profileSecrets;
    this.offExit = host.onExit((exit) => this.onExit(host, exit));
    this.enter('running');
    this.log.info('template host running', { start_ms: this.startedAt - began });
    this.deps.started(this.template, host);
  }

  private onStartFailed(run: Promise<TemplateHost>, err: unknown): void {
    if (this.starting !== run) return;
    this.starting = null;
    this.lastError = serializeError(err).message;
    this.log.warn('template host start failed', { err: serializeError(err) });
    this.failed(permanentFailure(err));
  }

  private onExit(host: TemplateHost, exit: TemplateHostExit): void {
    if (this.instance !== host) return;
    this.detach();
    const ranFor = this.startedAt === null ? 0 : this.deps.clock.now() - this.startedAt;
    this.startedAt = null;
    // A crash after a healthy run is not one more in a row (spec 13 §3.2 "consecutive").
    if (ranFor >= HEALTHY_RUN_MS) this.failures.clear();
    if (exit.operatorStop) {
      // The operator quit the browser: its sessions end, nothing restarts until the next launch.
      this.enter('stopped');
      this.log.info('template host stopped', { reason: 'operator' });
      void this.deps.closeSessions(host.viewIds(), 'operator');
      return;
    }
    this.lastError = exit.reason;
    this.failed(null);
  }

  /** One failure: `failed` (permanent cause or the fifth in the window), else `crashed` and a restart. */
  private failed(permanent: HostFailure | null): void {
    const count = this.failures.record(this.deps.clock.now());
    if (permanent !== null || count >= MAX_FAILURES) {
      this.failure = permanent ?? 'host_failed';
      this.enter('failed');
      this.deps.degradations.report({
        code: 'TEMPLATE_HOST_FAILED',
        severity: 'error',
        message: `template host ${this.templateId} failed: ${this.failure}`,
        details: { template_id: this.templateId, reason: this.failure, attempts: count },
      });
      return;
    }
    const delay = FailureWindow.backoff(count);
    this.enter('crashed');
    this.restartAt = this.deps.clock.now() + delay;
    this.scheduleRestart(delay);
  }

  private scheduleRestart(delay: number): void {
    this.cancelRestart();
    const timer = new AbortController();
    this.restartTimer = timer;
    this.deps.clock.sleep(delay, timer.signal).then(
      () => {
        if (this.restartTimer !== timer || this.state !== 'crashed') return;
        this.restartTimer = null;
        this.restartAt = null;
        if (!this.deps.slotFree()) {
          // No slot for a restart nobody asked for: start again on the next launch.
          this.enter('stopped');
          return;
        }
        this.restarts += 1;
        this.enter('starting');
        this.launch().catch(() => undefined);
      },
      () => undefined,
    );
  }

  private cancelRestart(): void {
    this.restartTimer?.abort();
    this.restartTimer = null;
    this.restartAt = null;
  }

  private detach(): void {
    this.offExit?.();
    this.offExit = null;
    this.instance = null;
    this.starting = null;
  }

  private enter(state: HostState): void {
    const changed = this.state !== state;
    this.state = state;
    this.since = this.deps.clock.now();
    if (changed) this.deps.changed?.(this.templateId);
  }
}

/** A start that does not settle within its deadline (spec 13 §3.2) fails. */
function withStartDeadline(start: Promise<TemplateHost>, clock: Clock): Promise<TemplateHost> {
  const timer = new AbortController();
  const late = clock.sleep(HOST_START_DEADLINE_MS, timer.signal).then(() => {
    // Close the host if it still arrives.
    start.then((host) => host.close(5_000)).catch(() => undefined);
    throw new Error('template host start timed out');
  });
  return Promise.race([start, late]).finally(() => timer.abort());
}

/** Waits for a start within the launch budget; on overrun the start continues (spec 13 §3.7). */
function raceBudget(
  start: Promise<TemplateHost>,
  signal: AbortSignal,
  name: string,
  refusal: () => Error,
): Promise<TemplateHost> {
  if (signal.aborted) return Promise.reject(templateUnavailable(name, 'starting'));
  return new Promise<TemplateHost>((resolve, reject) => {
    const onAbort = () => reject(templateUnavailable(name, 'starting'));
    signal.addEventListener('abort', onAbort, { once: true });
    start.then(
      (host) => {
        signal.removeEventListener('abort', onAbort);
        resolve(host);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        // The start's own failure is the host's (crashed/failed): answer what the state says.
        reject(refusal());
      },
    );
  });
}

/** @module app/templates/host-supervisor — `TemplateHostSupervisor`, the only code that launches or closes a template host (spec 13 §3.2): the `TemplateRuntime` behind the template service, admission and the virtual-session launch (§3.7, §6.3), idle stop, age recycle, memory sampling, maintenance sessions and shutdown. */

import type { ClosedReason } from '@browserhive/contracts/enums';
import type { SessionPrincipal } from '../../domain/session/principal.ts';
import type { Session } from '../../domain/session/session.ts';
import { NO_SEALING } from '../../domain/session/session-template.ts';
import { effectiveCap, pageCaps } from '../../domain/templates/model.ts';
import { settlesWithin, withDeadline } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  TemplateRecord,
  TemplateRepository,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { TemplateHost, TemplateHostLauncher } from '../../ports/template-host.ts';
import type {
  TemplateHostView,
  TemplateLaunchRequest,
  TemplateRuntime,
} from '../../ports/template-runtime.ts';
import type { SessionService } from '../sessions/session-service.ts';
import { HostLifecycle } from './host-lifecycle.ts';
import { buildHostSpec, type HostSpecDeps, observeStart } from './host-spec.ts';
import { idleExpired, nextIdleSince, recycleAt, TEMPLATE_LAUNCH_BUDGET_MS } from './host-state.ts';
import { hostViewOf } from './host-view.ts';
import { admitTemplateLaunch } from './template-admission.ts';
import { sessionTemplateOf, virtualLauncher, virtualSessionInput } from './virtual-launch.ts';

/** The slug of the per-host system maintenance session; it does not keep a host from idling. */
export const SYSTEM_MAINTENANCE_SLUG = 'maintenance';

/** Supervisor settings (08 §5.9; durations in ms, `0` = never). */
export interface HostSupervisorConfig {
  readonly idleTimeoutMs: number;
  readonly recycleAfterMs: number;
  readonly drainTimeoutMs: number;
  readonly maxPagesPerHost: number;
  readonly closeTimeoutMs: number;
}

/** Collaborators of {@link TemplateHostSupervisor}. */
export interface HostSupervisorDeps {
  readonly launcher: TemplateHostLauncher;
  readonly sessions: SessionService;
  readonly templates: Pick<TemplateRepository, 'update' | 'touchLastUsed'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly degradations: DegradationReporter;
  readonly spec: HostSpecDeps;
  readonly config: HostSupervisorConfig;
  /** Resident memory of a browser's process tree (spec 13 §3.2 memory); absent = not sampled. */
  readonly rssOf?: (pid: number) => Promise<number | null>;
}

/** Owns every template host, keyed by template id. */
export class TemplateHostSupervisor implements TemplateRuntime {
  private readonly deps: HostSupervisorDeps;
  private readonly log: Logger;
  private readonly hosts = new Map<string, HostLifecycle>();
  /** Launches admitted and not finished, per template (the cap counts them, spec 13 §6.3). */
  private readonly pending = new Map<string, number>();
  private readonly rss = new Map<string, number>();

  constructor(deps: HostSupervisorDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ module: 'templates.supervisor' });
    deps.sessions.setHostSlots(() => this.slots());
  }

  /** Starting, running or draining hosts: each holds one browser slot (spec 13 §6.3). */
  slots(): number {
    let n = 0;
    for (const lifecycle of this.hosts.values()) if (lifecycle.holdsSlot) n++;
    return n;
  }

  /** Hosts per state, for `browserhive.template.hosts` and operator views. */
  states(): ReadonlyMap<string, HostLifecycle['state']> {
    return new Map([...this.hosts].map(([id, lifecycle]) => [id, lifecycle.state]));
  }

  host(templateId: string): TemplateHostView {
    return hostViewOf(this.hosts.get(templateId), {
      liveAgentSessions: this.liveSessions(templateId).length,
      rssBytes: this.rss.get(templateId) ?? null,
      recycleAfterMs: this.deps.config.recycleAfterMs,
    });
  }

  /** The running host of a template, or `null` (operator operations, `TemplateHostOps`). */
  runningHost(templateId: string): TemplateHost | null {
    return this.hosts.get(templateId)?.running ?? null;
  }

  /** Stops a template's host, closing its sessions with `operator` (clearing saved passwords). */
  async stopHost(templateId: string, reason: string): Promise<void> {
    await this.hosts.get(templateId)?.stop(reason, 'operator');
  }

  liveSessions(templateId: string): readonly string[] {
    return this.sessionsOf(templateId, 'live').map((s) => s.id);
  }

  /**
   * A virtual session (spec 13 §3.7 after `validate`): `TemplateAdmission` once, then the template
   * branch of the pipeline within the 50 s budget.
   */
  async launch(request: TemplateLaunchRequest, signal?: AbortSignal): Promise<Session> {
    const { template } = request;
    const lifecycle = this.lifecycleOf(template);
    const cap = effectiveCap(template);
    const caps = pageCaps(this.deps.config.maxPagesPerHost, cap);
    admitTemplateLaunch({
      name: template.name,
      state: lifecycle.state,
      retryAfterMs:
        lifecycle.restartAt === null ? null : lifecycle.restartAt - this.deps.clock.now(),
      agentSessions:
        this.liveSessions(template.templateId).length + this.pendingOf(template.templateId),
      cap,
      agentPages: lifecycle.current?.agentPageCount() ?? 0,
      caps,
    });
    const session = sessionTemplateOf(template, request.sites, 'live', request.sealing);
    return this.run(
      template.templateId,
      async (budget) => {
        const created = await this.deps.sessions.createVirtual(
          virtualSessionInput(request),
          request.principal,
          virtualLauncher({
            lifecycle,
            template,
            session,
            caps,
            onPageLimit: (id) => this.pageLimitWarning(id),
          }),
          { signal: budget, deadlineMs: TEMPLATE_LAUNCH_BUDGET_MS },
        );
        await this.deps.templates
          .touchLastUsed(template.templateId, this.deps.clock.now())
          .catch((err: unknown) =>
            this.log.warn('last use not stamped', { err: serializeError(err) }),
          );
        return created;
      },
      signal,
    );
  }

  /**
   * A maintenance session on the template's host (spec 13 §1.1): recording and re-login (slug
   * `recording`/`relogin`, owned by the operator) or the host's own work (slug `maintenance`, owned
   * by `browserhive`). No cap, no admission beyond the host state; never an agent's.
   */
  async launchMaintenance(input: {
    readonly template: TemplateRecord;
    readonly sites: readonly TemplateSiteRecord[];
    readonly slug: string;
    readonly principal: SessionPrincipal;
    /** A recording or re-login window: agent windows are minimized while it is open (§3.3). */
    readonly recording?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<Session> {
    const { template } = input;
    const lifecycle = this.lifecycleOf(template);
    if (
      lifecycle.state === 'failed' ||
      lifecycle.state === 'draining' ||
      lifecycle.state === 'crashed'
    ) {
      throw lifecycle.refusal();
    }
    const session = sessionTemplateOf(template, input.sites, 'maintenance', NO_SEALING);
    return this.run(
      template.templateId,
      (budget) =>
        this.deps.sessions.createVirtual(
          {
            slug: input.slug,
            channel: template.channel,
            headless: template.headless,
            incognito: false,
            persistenceMode: 'memory',
            disableEvaluate: false,
            vaultEnabled: false,
            stealth: template.stealth !== 'off',
            fingerprint: template.fingerprint,
            humanize: false,
          },
          input.principal,
          virtualLauncher({
            lifecycle,
            template,
            session,
            caps: null,
            ...(input.recording === true && { recording: true }),
          }),
          { signal: budget, deadlineMs: TEMPLATE_LAUNCH_BUDGET_MS },
        ),
      input.signal,
    );
  }

  /** Before a delete: closes every session of the template and stops its host (spec 13 §2.6). */
  async shutdown(templateId: string): Promise<readonly string[]> {
    const live = this.liveSessions(templateId);
    // The host goes `draining` before anything is awaited, so no launch attaches meanwhile.
    await this.hosts.get(templateId)?.stop('template deleted', 'operator');
    this.hosts.delete(templateId);
    await this.closeSessions(
      this.sessionsOf(templateId, null).map((s) => s.id),
      'operator',
    );
    this.rss.delete(templateId);
    return live;
  }

  /**
   * The periodic pass (spec 13 §3.2): idle stop, age recycle and memory sampling. Never throws;
   * the composition calls it on an interval.
   */
  async tick(): Promise<void> {
    const now = this.deps.clock.now();
    for (const lifecycle of [...this.hosts.values()]) {
      const host = lifecycle.running;
      if (host === null) continue;
      try {
        lifecycle.idleSince = nextIdleSince(
          lifecycle.idleSince,
          this.inUse(lifecycle.templateId, host),
          now,
        );
        if (idleExpired(lifecycle.idleSince, this.deps.config.idleTimeoutMs, now)) {
          await lifecycle.stop('idle');
          continue;
        }
        const due = recycleAt(lifecycle.startedAt, this.deps.config.recycleAfterMs);
        if (due !== null && now >= due) {
          void this.recycle(lifecycle, 'shutdown');
          continue;
        }
        await this.sample(lifecycle.templateId, host);
      } catch (err) {
        this.log.warn('host tick failed', {
          templateId: lifecycle.templateId,
          err: serializeError(err),
        });
      }
    }
  }

  /** Drains and stops a host (recycle, operator restart); new launches answer `TEMPLATE_UNAVAILABLE`. */
  async recycle(lifecycle: HostLifecycle, reason: ClosedReason): Promise<void> {
    await lifecycle.drain(
      () => this.liveSessions(lifecycle.templateId),
      this.deps.config.drainTimeoutMs,
      reason,
    );
    // The maintenance session closes with its host.
    await this.closeSessions(
      this.sessionsOf(lifecycle.templateId, null).map((s) => s.id),
      reason,
    );
  }

  /**
   * Daemon shutdown: every template session closes with `shutdown`, then every host, within
   * `deadlineMs` when given (PR #76 F12): a host still starting at the deadline is closed when its
   * start finishes, and a close that overruns kills its browser.
   */
  async stopAll(deadlineMs?: number): Promise<void> {
    const ids = [...this.hosts.keys()];
    const stopping = Promise.allSettled(
      ids.map(async (id) => {
        await this.hosts.get(id)?.stop('shutdown');
        await this.closeSessions(
          this.sessionsOf(id, null).map((s) => s.id),
          'shutdown',
        );
      }),
    );
    const sleep = (ms: number, signal?: AbortSignal) => this.deps.clock.sleep(ms, signal);
    if (deadlineMs === undefined) await stopping;
    else if (!(await settlesWithin(stopping, sleep, deadlineMs))) {
      this.log.warn('hosts closing past budget', { deadlineMs });
    }
    this.hosts.clear();
  }

  // --- internals ----------------------------------------------------------------------------------

  private async run(
    templateId: string,
    launch: (budget: AbortSignal) => Promise<Session>,
    signal?: AbortSignal,
  ): Promise<Session> {
    const budget = withDeadline(signal, TEMPLATE_LAUNCH_BUDGET_MS);
    this.pending.set(templateId, this.pendingOf(templateId) + 1);
    try {
      return await launch(budget.signal);
    } finally {
      this.pending.set(templateId, Math.max(0, this.pendingOf(templateId) - 1));
      budget.clear();
    }
  }

  private pendingOf(templateId: string): number {
    return this.pending.get(templateId) ?? 0;
  }

  private lifecycleOf(template: TemplateRecord): HostLifecycle {
    const existing = this.hosts.get(template.templateId);
    if (existing !== undefined) {
      existing.refresh(template);
      return existing;
    }
    const lifecycle = new HostLifecycle(template, {
      launcher: this.deps.launcher,
      clock: this.deps.clock,
      logger: this.deps.logger,
      degradations: this.deps.degradations,
      buildSpec: (record) => buildHostSpec(record, this.deps.spec),
      started: (record, host) => this.started(record, host),
      closeSessions: (ids, reason) => this.closeSessions(ids, reason),
      slotFree: () => {
        const cap = this.deps.sessions.capacity();
        return cap === null || this.deps.sessions.occupiedSlots() < cap;
      },
      closeTimeoutMs: this.deps.config.closeTimeoutMs,
    });
    this.hosts.set(template.templateId, lifecycle);
    return lifecycle;
  }

  /** Sessions of a template: `live` (agents), `maintenance`, or every one (`null`). */
  sessionsOf(templateId: string, mode: 'live' | 'maintenance' | null): readonly Session[] {
    return this.deps.sessions
      .listAll()
      .filter(
        (s) => s.template?.templateId === templateId && (mode === null || s.template.mode === mode),
      );
  }

  /** In use: an agent session, a recording or re-login, or a parked page other than the sentinel. */
  private inUse(templateId: string, host: TemplateHost): boolean {
    const working = this.sessionsOf(templateId, null).some(
      (s) => s.template?.mode === 'live' || s.slug !== SYSTEM_MAINTENANCE_SLUG,
    );
    return working || host.parkedPages().length > 0;
  }

  private async closeSessions(ids: readonly string[], reason: ClosedReason): Promise<void> {
    await Promise.allSettled(ids.map((id) => this.deps.sessions.close(id, reason)));
  }

  /** First start: record the observed identity (spec 13 §2.2); later ones only compare the major. */
  private started(template: TemplateRecord, host: TemplateHost): void {
    const seen = observeStart(template, host, this.deps.clock.now());
    if (seen?.kind === 'drift') {
      this.log.warn('identity drift', { templateId: template.templateId, ...seen });
    }
    if (seen?.kind !== 'record') return;
    this.deps.templates.update(template.templateId, { identityObserved: seen.record }).then(
      (updated) => this.hosts.get(template.templateId)?.refresh(updated),
      (err: unknown) => this.log.warn('observed identity unsaved', { err: serializeError(err) }),
    );
  }

  /** The session's warning after a site-opened page over its cap was closed (spec 13 §6.3). */
  private pageLimitWarning(sessionId: string): void {
    const session = this.deps.sessions.peek(sessionId);
    if (session === undefined) return;
    this.deps.sessions.warn(session, {
      code: 'SESSION_PAGE_LIMIT',
      sessionId,
      message:
        'This session has reached its tab limit; a page a site opened was closed. Close a tab you no longer need.',
    });
  }

  private async sample(templateId: string, host: TemplateHost): Promise<void> {
    const rssOf = this.deps.rssOf;
    if (rssOf === undefined || host.browserPid === undefined) return;
    const pid = await host.browserPid();
    if (pid === null) return;
    const rss = await rssOf(pid);
    if (rss !== null) this.rss.set(templateId, rss);
  }
}

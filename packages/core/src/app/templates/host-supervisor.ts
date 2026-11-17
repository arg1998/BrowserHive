/** @module app/templates/host-supervisor — `TemplateHostSupervisor`, the only code that launches or closes a template host (spec 13 §3.2): the `TemplateRuntime` behind the template service, admission and the virtual-session launch (§3.7, §6.3), idle stop, age recycle, memory sampling, maintenance sessions and shutdown. */

import type { ClosedReason } from '@browserhive/contracts/enums';
import type { Session } from '../../domain/session/session.ts';
import { NO_SEALING } from '../../domain/session/session-template.ts';
import { effectiveCap, pageCaps } from '../../domain/templates/model.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import type { TemplateHost } from '../../ports/template-host.ts';
import type {
  TemplateHostView,
  TemplateLaunchRequest,
  TemplateRuntime,
} from '../../ports/template-runtime.ts';
import { HostEvents, PendingLaunches, sampleRss } from './host-events.ts';
import { TemplateHolds } from './host-holds.ts';
import { HostLifecycle } from './host-lifecycle.ts';
import {
  HostMemoryGuard,
  PAGE_LIMIT_MESSAGE,
  RESOURCE_LIMIT_MESSAGE,
  warnSession,
} from './host-memory.ts';
import { IdentityObserver, stopHosts } from './host-shutdown.ts';
import { buildHostSpec } from './host-spec.ts';
import { idleExpired, nextIdleSince, recycleAt, TEMPLATE_LAUNCH_BUDGET_MS } from './host-state.ts';
import type {
  HostCheckpoints,
  HostSupervisorDeps,
  MaintenanceLaunch,
  PrelaunchOutcome,
  SupervisorHealth,
} from './host-supervisor-types.ts';
import { SYSTEM_MAINTENANCE_SLUG } from './host-supervisor-types.ts';
import { hostViewOf } from './host-view.ts';
import { reportPrelaunch } from './prelaunch-report.ts';
import { admitTemplateLaunch, templateUnavailable } from './template-admission.ts';
import { notFoundForOperator } from './template-errors.ts';
import { TemplatePause } from './template-pause.ts';
import { toHostView } from './views.ts';
import {
  maintenanceSessionInput,
  sessionTemplateOf,
  virtualLauncher,
  virtualSessionInput,
} from './virtual-launch.ts';

export type {
  HostCheckpoints,
  HostSupervisorConfig,
  HostSupervisorDeps,
  PrelaunchOutcome,
  SupervisorHealth,
} from './host-supervisor-types.ts';
export { SYSTEM_MAINTENANCE_SLUG } from './host-supervisor-types.ts';

/** Owns every template host, keyed by template id. */
export class TemplateHostSupervisor implements TemplateRuntime {
  private readonly deps: HostSupervisorDeps;
  private readonly log: Logger;
  private readonly hosts = new Map<string, HostLifecycle>();
  /** Launches admitted and not finished, per template (the cap counts them, spec 13 §6.3). */
  private readonly pending = new PendingLaunches();
  private readonly rss = new Map<string, number>();
  /** `template.host` with the names and the state left (host notifications). */
  private readonly events: HostEvents;
  /** Templates held by an operation (restore, seed, clearing saved passwords): agents wait. */
  readonly holds = new TemplateHolds();
  private readonly memory: HostMemoryGuard;
  private checkpoints: HostCheckpoints | null = null;
  /** The observed identity and its drift (spec 13 §2.2). */
  readonly identity: IdentityObserver;
  /** Agents wait while a sign-in window is open (D-60). */
  readonly pause: TemplatePause;
  private health: SupervisorHealth = {}; // attached at composition (spec 13 §8.2, §8.3)

  constructor(deps: HostSupervisorDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ module: 'templates.supervisor' });
    deps.sessions.setHostSlots(() => this.slots());
    this.identity = new IdentityObserver({
      templates: deps.templates,
      clock: deps.clock,
      log: this.log,
      changed: (updated, id) => {
        if (updated !== null) this.hosts.get(id)?.refresh(updated);
        deps.onTemplateChanged?.(id);
      },
    });
    this.events = new HostEvents(deps.bus, (id) => toHostView(this.host(id)));
    this.pause = new TemplatePause({
      clock: deps.clock,
      alive: (sessionId) => {
        const kind = deps.sessions.peek(sessionId)?.state.kind;
        return kind !== undefined && kind !== 'closed' && kind !== 'crashed';
      },
      changed: (id) => this.publishHost(id),
    });
    this.memory = new HostMemoryGuard({
      limitBytes: deps.config.recycleRssBytes ?? 0,
      clock: deps.clock,
      logger: deps.logger,
      warn: (id, details) =>
        warnSession(deps.sessions, id, 'SESSION_RESOURCE_LIMIT', RESOURCE_LIMIT_MESSAGE, details),
    });
  }

  /** The health hooks: the pre-launch check and the probe after a browser start. */
  attachHealth(health: SupervisorHealth): void {
    this.health = health;
  }

  /** The checkpoint writer (set once at composition; it reads hosts back through `runningHost`). */
  attachCheckpoints(checkpoints: HostCheckpoints): void {
    this.checkpoints = checkpoints;
  }

  /** The lifecycle of a template's host (operator host operations). */
  lifecycle(template: TemplateRecord): HostLifecycle {
    return this.lifecycleOf(template);
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
      agentsPaused: this.pause.paused(templateId),
      identityDrift: this.identity.drift(templateId),
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
    if (this.holds.held(template.templateId))
      throw templateUnavailable(template.name, 'restarting');
    // A sign-in window is open: the launch waits for the operator, bounded, inside its budget (D-60).
    const waitStarted = this.deps.clock.now();
    await this.pause.wait(template.templateId, template.name, signal);
    const waited = this.deps.clock.now() - waitStarted;
    const lifecycle = this.lifecycleOf(template);
    const cap = effectiveCap(template);
    const caps = pageCaps(this.deps.config.maxPagesPerHost, cap);
    admitTemplateLaunch({
      name: template.name,
      state: lifecycle.state,
      retryAfterMs:
        lifecycle.restartAt === null ? null : lifecycle.restartAt - this.deps.clock.now(),
      agentSessions:
        this.liveSessions(template.templateId).length + this.pending.count(template.templateId),
      cap,
      agentPages: lifecycle.current?.agentPageCount() ?? 0,
      caps,
    });
    const session = sessionTemplateOf(template, request.sites, 'live', request.sealing);
    const prelaunch = this.health.prelaunch;
    let checked: PrelaunchOutcome | null = null;
    return this.pending.run(
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
            onPageLimit: (id) =>
              warnSession(this.deps.sessions, id, 'SESSION_PAGE_LIMIT', PAGE_LIMIT_MESSAGE),
            ...(prelaunch !== undefined && {
              afterAcquire: async (s: AbortSignal) => {
                checked = await prelaunch(template, s);
              },
            }),
          }),
          { signal: budget, deadlineMs: TEMPLATE_LAUNCH_BUDGET_MS },
        );
        if (checked !== null) reportPrelaunch(this.deps.sessions, created, checked);
        const at = this.deps.clock.now();
        await this.deps.templates.touchLastUsed(template.templateId, at).catch(() => undefined);
        return created;
      },
      signal,
      TEMPLATE_LAUNCH_BUDGET_MS - waited,
    );
  }

  /**
   * A maintenance session on the template's host (spec 13 §1.1): recording and re-login (slug
   * `recording`/`relogin`, owned by the operator) or the host's own work (slug `maintenance`, owned
   * by `browserhive`). No cap, no admission beyond the host state; never an agent's.
   */
  async launchMaintenance(input: MaintenanceLaunch): Promise<Session> {
    const { template } = input;
    if (!this.holds.admits(template.templateId, input.holdToken)) {
      throw templateUnavailable(template.name, 'restarting');
    }
    const lifecycle = this.lifecycleOf(template);
    if (['failed', 'draining', 'crashed'].includes(lifecycle.state)) throw lifecycle.refusal();
    const session = sessionTemplateOf(template, input.sites, 'maintenance', NO_SEALING);
    return this.pending.run(
      template.templateId,
      (budget) =>
        this.deps.sessions.createVirtual(
          maintenanceSessionInput(template, input.slug),
          input.principal,
          virtualLauncher({
            lifecycle,
            template,
            session,
            caps: null,
            ...(input.recording === true && { recording: true }),
            ...(input.background === true && { background: true }),
          }),
          { signal: budget, deadlineMs: TEMPLATE_LAUNCH_BUDGET_MS },
        ),
      input.signal,
    );
  }

  /** Before a delete: closes every session of the template and stops its host (spec 13 §2.6). */
  async shutdown(templateId: string): Promise<readonly string[]> {
    // From now on no browser starts for this id, whatever an operation in flight still does.
    this.holds.delete(templateId);
    const live = this.liveSessions(templateId);
    // The host goes `draining` before anything is awaited, so no launch attaches meanwhile.
    await this.hosts.get(templateId)?.stop('template deleted', 'operator', false);
    this.hosts.delete(templateId);
    this.memory.forget(templateId);
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
        const rss = await sampleRss(this.deps.rssOf, host);
        if (rss !== null) this.rss.set(lifecycle.templateId, rss);
        const memory =
          rss === null ? 'ok' : await this.memory.check(lifecycle.templateId, rss, host);
        if ((due !== null && now >= due) || memory === 'drain') {
          void this.recycle(lifecycle, 'shutdown');
          continue;
        }
        await this.checkpoints?.checkpointIfDue(lifecycle.templateId, lifecycle.startedAt);
        this.publishHost(lifecycle.templateId);
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
    // Only what exists now: a stop that overruns the deadline must never close a later session.
    const stops = [...this.hosts].map(([id, lifecycle]) => ({
      lifecycle,
      sessions: this.sessionsOf(id, null).map((s) => s.id),
    }));
    await stopHosts(
      stops,
      (ids, r) => this.closeSessions(ids, r),
      this.deps.clock,
      this.log,
      deadlineMs,
    );
    this.hosts.clear();
  }

  // --- internals ----------------------------------------------------------------------------------

  private lifecycleOf(template: TemplateRecord): HostLifecycle {
    if (this.holds.deleted(template.templateId)) throw notFoundForOperator(template.templateId);
    this.events.remember(template);
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
      started: (record, host) => {
        this.identity.started(record, host);
        this.health.hostStarted?.(record.templateId);
      },
      closeSessions: (ids, reason) => this.closeSessions(ids, reason),
      slotFree: () => {
        const cap = this.deps.sessions.capacity();
        return cap === null || this.deps.sessions.occupiedSlots() < cap;
      },
      closeTimeoutMs: this.deps.config.closeTimeoutMs,
      beforeClose: async () => {
        await this.checkpoints?.checkpoint(template.templateId);
      },
      changed: (id) => this.publishHost(id),
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

  /** `template.host` on the `templates` topic (with the names and state left for notifications). */
  publishHost(templateId: string): void {
    this.events.publish(templateId);
  }
}

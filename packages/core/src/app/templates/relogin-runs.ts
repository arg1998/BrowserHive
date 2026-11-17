/** @module app/templates/relogin-runs — the re-login of each template as operators see it (spec 13 §8.4): one run per template, its `ReloginView` on the `templates` topic, and how a run ends (the window closes, so the agents' pause ends with it) or succeeds (health, a `relogin` version, the unlisted sign-ins). */

import type { ReloginView } from '@browserhive/contracts/http';
import type { Session } from '../../domain/session/session.ts';
import { providerOf } from '../../domain/templates/probe.ts';
import { unlistedDomains } from '../../domain/templates/sign-ins.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { DomainEvents, TemplateNames } from '../events/catalog.ts';
import type { SessionService } from '../sessions/session-service.ts';
import type { TemplateHostOperations } from './host-operations.ts';
import type { TemplateHostSupervisor } from './host-supervisor.ts';
import type { TemplateHealthService } from './template-health.ts';
import type { TemplateStateService } from './template-state.ts';

/** The states a re-login is still running in. */
export const ACTIVE = new Set<ReloginView['state']>(['queued', 'open', 'filling']);

/** What a window's site looked like when it opened (spec 13 §8.4, review #81 M-5). */
export interface SiteBaseline {
  /** Every cookie name of the jar (`<site>\t<name>`): what **I'm signed in** learns against. */
  readonly names: ReadonlySet<string>;
  /** The site's learned sign-in cookies present then, with their expiry (epoch s). */
  readonly learned: ReadonlyMap<string, number>;
}

/** One template's re-login. */
export interface Running {
  view: ReloginView;
  readonly templateId: string;
  baseline: SiteBaseline | null;
  /** The window's watch loop stops when this aborts. */
  readonly stop: AbortController;
  /** For notification titles (`template.relogin_failed`). */
  readonly names: TemplateNames;
  readonly provider: string;
  /** The queued → open transition in flight: a second Show window awaits it (review #81 H-1). */
  opening: Promise<void> | null;
  /** The operator's last input in a live-view re-login (agents wait only while they sign in). */
  lastInputAt: number | null;
}

/** Collaborators of {@link ReloginRuns}. */
export interface ReloginRunsDeps {
  readonly repos: Pick<Repositories, 'templateSites'>;
  readonly supervisor: Pick<TemplateHostSupervisor, 'pause'>;
  readonly ops: Pick<TemplateHostOperations, 'jar'>;
  readonly sessions: Pick<SessionService, 'close' | 'peek'>;
  readonly health: Pick<TemplateHealthService, 'record'>;
  readonly state?: Pick<TemplateStateService, 'saveVersion'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bus?: EventPublisher<DomainEvents>;
  readonly machine: string;
  readonly changed?: (templateId: string) => void;
}

/** The re-login runs of every template. */
export class ReloginRuns {
  readonly #deps: ReloginRunsDeps;
  readonly #log: Logger;
  readonly #runs = new Map<string, Running>();

  constructor(deps: ReloginRunsDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.relogin' });
  }

  /** The current or last run of a template. */
  get(templateId: string): Running | undefined {
    return this.#runs.get(templateId);
  }

  /** The run still in progress (queued, open or filling), or `null`. */
  active(templateId: string): Running | null {
    const run = this.#runs.get(templateId);
    return run !== undefined && ACTIVE.has(run.view.state) ? run : null;
  }

  /** The active run whose window or fill is `sessionId`, or `null`. */
  bySession(sessionId: string): Running | null {
    for (const run of this.#runs.values()) {
      if (ACTIVE.has(run.view.state) && run.view.session_id === sessionId) return run;
    }
    return null;
  }

  /** A run is still the template's current one and still running. */
  current(run: Running): boolean {
    return this.#runs.get(run.templateId) === run && ACTIVE.has(run.view.state);
  }

  /** Starts a run; a run still active is ended (`cancelled`, `replaced`) and its window closed. */
  begin(
    template: TemplateRecord,
    site: TemplateSiteRecord,
    method: 'window' | 'vault',
    by: string,
    state: ReloginView['state'],
  ): Running {
    const old = this.active(template.templateId);
    if (old !== null) void this.end(old, 'cancelled', 'replaced');
    const run: Running = {
      templateId: template.templateId,
      baseline: null,
      stop: new AbortController(),
      names: { name: template.name, display_name: template.displayName },
      provider: providerOf(site),
      opening: null,
      lastInputAt: null,
      view: {
        site_id: site.siteId,
        method,
        state,
        session_id: null,
        requested_by: by,
        requested_at: this.#deps.clock.now(),
        deadline_at: null,
        finished_at: null,
        agents_paused: false,
        sign_in_via: null,
        confirm_required: false,
        version: null,
        unlisted_domains: [],
        error: null,
      },
    };
    this.#runs.set(template.templateId, run);
    this.publish(run, {});
    return run;
  }

  /** Ends a run: its window closes (the pause with it) and the outcome is published. */
  async end(run: Running, state: ReloginView['state'], error: string | null): Promise<void> {
    if (!ACTIVE.has(run.view.state)) return;
    run.stop.abort();
    const session = run.view.session_id;
    this.publish(run, {
      state,
      error,
      finished_at: this.#deps.clock.now(),
      deadline_at: null,
      agents_paused: false,
    });
    if (session !== null) await this.closeWindow(run.templateId, session);
    this.#log.info('re-login ended', { templateId: run.templateId, state, error });
  }

  /** Closes a window and ends its pause. */
  async closeWindow(templateId: string, sessionId: string): Promise<void> {
    this.#deps.supervisor.pause.close(templateId, sessionId);
    await this.#deps.sessions.close(sessionId, 'operator').catch(() => undefined);
  }

  /** The site is signed in again: health (resolves the notification), version, unlisted sign-ins. */
  async succeed(
    run: Running,
    template: TemplateRecord,
    siteId: string,
    by: string,
    reason: string,
  ): Promise<void> {
    if (!ACTIVE.has(run.view.state)) return;
    const { deps } = this;
    await deps.health.record(
      template,
      siteId,
      { outcome: 'signed_in', reason, finalUrl: null },
      'relogin',
    );
    let version: number | null = null;
    try {
      version =
        (await deps.state?.saveVersion(template.templateId, { reason: 'relogin', by })) ?? null;
    } catch (err) {
      this.#log.warn('re-login version failed', {
        templateId: template.templateId,
        err: serializeError(err),
      });
    }
    const sites = await deps.repos.templateSites.list(template.templateId);
    const jar = (await deps.ops.jar(template.templateId)) ?? [];
    const unlisted = unlistedDomains(
      jar,
      sites.map((s) => s.siteId),
    );
    run.view = { ...run.view, version, unlisted_domains: unlisted };
    await this.end(run, 'signed_in', null);
    deps.changed?.(template.templateId);
  }

  /** Publishes the run's view on the `templates` topic, with the names notifications need. */
  publish(run: Running, patch: Partial<ReloginView>): void {
    run.view = { ...run.view, ...patch };
    this.#deps.bus?.publish('template.relogin', {
      type: 'template.relogin',
      template_id: run.templateId,
      relogin: { ...run.view },
      names: run.names,
      provider: run.provider,
      machine: this.#deps.machine,
    });
  }

  /** The run's open session, or `null` when it closed. */
  session(run: Running): Session | null {
    const id = run.view.session_id;
    if (id === null) return null;
    const session = this.#deps.sessions.peek(id);
    const kind = session?.state.kind;
    return session === undefined || kind === 'closed' || kind === 'crashed' ? null : session;
  }

  /** The deps (for the window and the service). */
  get deps(): ReloginRunsDeps {
    return this.#deps;
  }
}

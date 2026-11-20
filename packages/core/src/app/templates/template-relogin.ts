/** @module app/templates/template-relogin — re-login (spec 13 §8.4): a window (queued by a notification button, opened by **Show window**), **I'm signed in** / **Done**, the vault fill as `template:<id>` (`relogin-vault.ts`), and the agents' pause (D-60). One re-login per template at a time: a second request gets the running one or a typed `CONFLICT` (review #81 H-1). Runs live in `relogin-runs.ts`, windows in `relogin-window.ts`. */

import type { ReloginResponse, ReloginView } from '@browserhive/contracts/http';
import type { SessionPrincipal } from '../../domain/session/principal.ts';
import { cookieSite, learnedCookieNames } from '../../domain/templates/sign-ins.ts';
import type { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type {
  Repositories,
  TemplateRecord,
  TemplateSiteRecord,
} from '../../ports/persistence/index.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import type { TemplateHostOperations } from './host-operations.ts';
import type { TemplateHostSupervisor } from './host-supervisor.ts';
import { ReloginRuns, type ReloginRunsDeps, type Running } from './relogin-runs.ts';
import { type ReloginVault, ReloginVaultFill } from './relogin-vault.ts';
import { ReloginWindows } from './relogin-window.ts';
import { disabled, notFoundForOperator, validationFailed } from './template-errors.ts';
import { healthConflict, type TemplateHealthService } from './template-health.ts';

export { RELOGIN_POLL_MS, RELOGIN_SLUG, RELOGIN_WINDOW_MS } from './relogin-window.ts';

/** Collaborators of {@link TemplateReloginService}. */
export interface TemplateReloginDeps
  extends Omit<ReloginRunsDeps, 'repos' | 'supervisor' | 'ops' | 'health'> {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'operatorActions'>;
  readonly supervisor: Pick<TemplateHostSupervisor, 'pause' | 'launchMaintenance' | 'host'>;
  readonly ops: Pick<
    TemplateHostOperations,
    'openSignInWindow' | 'raiseWindow' | 'recordingOf' | 'jar' | 'held'
  >;
  readonly health: Pick<TemplateHealthService, 'record' | 'probe'>;
  /** Absent under `vault=off`. */
  readonly vault?: ReloginVault;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  /** A headed browser can open a window on this machine; default: yes. */
  readonly displayAvailable?: () => boolean;
}

/** Re-login of template sites. */
export class TemplateReloginService {
  readonly #deps: TemplateReloginDeps;
  readonly #runs: ReloginRuns;
  readonly #windows: ReloginWindows;
  readonly #vault: ReloginVaultFill | null;

  constructor(deps: TemplateReloginDeps) {
    this.#deps = deps;
    this.#runs = new ReloginRuns(deps);
    this.#windows = new ReloginWindows({
      runs: this.#runs,
      repos: deps.repos,
      supervisor: deps.supervisor,
      ops: deps.ops,
      displayAvailable: deps.displayAvailable ?? (() => true),
    });
    this.#vault =
      deps.vault === undefined
        ? null
        : new ReloginVaultFill({
            vault: deps.vault,
            supervisor: deps.supervisor,
            sessions: deps.sessions,
            health: deps.health,
            repos: deps.repos,
            clock: deps.clock,
            logger: deps.logger,
          });
  }

  /** The current or last re-login of a template (`GET /templates/{id}`). */
  view(templateId: string): ReloginView | null {
    const run = this.#runs.get(templateId);
    return run === undefined ? null : { ...run.view };
  }

  /**
   * `POST /templates/{id}/relogin`. A window re-login of the site a queued one is for opens that one.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `TEMPLATE_DISABLED`, `VALIDATION_FAILED`, `CONFLICT` (a
   *   re-login or recording is running, the template is still being set up), and the start refusals.
   */
  async start(
    templateId: string,
    request: {
      readonly siteId: string;
      readonly method: 'window' | 'vault';
      readonly letAgentsContinue?: boolean;
    },
    principal: SessionPrincipal,
  ): Promise<ReloginResponse> {
    const { template, site } = await this.#load(templateId, request.siteId);
    this.#assertStartable(template);
    const active = this.#runs.active(templateId);
    if (active !== null && (active.view.state !== 'queued' || active.opening !== null)) {
      throw healthConflict(
        `A re-login of ${active.view.site_id} is already running for this template.`,
      );
    }
    if (request.method === 'vault') {
      const vault = this.#vaultFor(site);
      const run = this.#runs.begin(template, site, 'vault', principal.subject, 'filling');
      await this.#audit(principal.subject, templateId, { site_id: site.siteId, method: 'vault' });
      void this.#runVault(vault, template, site, run, 'manual');
      return this.#response(run);
    }
    const queued = active !== null && active.view.site_id === site.siteId ? active : null;
    const run = queued ?? this.#runs.begin(template, site, 'window', principal.subject, 'queued');
    await this.#audit(principal.subject, templateId, { site_id: site.siteId, method: 'window' });
    await this.#open(run, principal, request.letAgentsContinue === true);
    return this.#response(run);
  }

  /** The `template.relogin` act button (spec 13 §8.6): only queues; an active re-login is left as it is. */
  async queue(templateId: string, siteId: string, presser: string): Promise<ReloginView> {
    const { template, site } = await this.#load(templateId, siteId);
    const active = this.#runs.active(templateId);
    if (active !== null) return { ...active.view };
    if (template.status === 'disabled') throw disabled(template.name);
    const run = this.#runs.begin(template, site, 'window', presser, 'queued');
    const details = { site_id: site.siteId, method: 'window', queued: true, presser };
    await this.#audit(presser, templateId, details);
    return { ...run.view };
  }

  /**
   * `POST /templates/{id}/host/show`: opens the queued re-login window (once, whoever presses), or
   * raises the open re-login or recording window.
   *
   * @throws AppError `CONFLICT` when nothing is queued or open.
   */
  async show(
    templateId: string,
    principal: SessionPrincipal,
  ): Promise<{ window: 'relogin' | 'recording'; sessionId: string }> {
    const run = this.#runs.active(templateId);
    if (run !== null && run.view.method === 'window') {
      if (run.view.state === 'queued') await this.#open(run, principal, false);
      else await this.#windows.raise(run);
      if (run.view.session_id !== null && this.#runs.current(run)) {
        await this.#audit(
          principal.subject,
          templateId,
          { window: 'relogin' },
          'template.host.show',
        );
        return { window: 'relogin', sessionId: run.view.session_id };
      }
    }
    const recording = this.#deps.ops.recordingOf(templateId);
    if (recording !== null) {
      await this.#deps.ops.raiseWindow(recording);
      await this.#audit(
        principal.subject,
        templateId,
        { window: 'recording' },
        'template.host.show',
      );
      return { window: 'recording', sessionId: recording.id };
    }
    throw healthConflict('No sign-in window is queued or open for this template.');
  }

  /**
   * `POST /templates/{id}/relogin/confirm` (**I'm signed in**, or **Done** when the site's cookies
   * were already there): learns the names that appeared since the window opened (or keeps the
   * present ones) and finishes the re-login.
   *
   * `requestedAt` (the re-login the caller saw) must still be the current one (review #81 L-2).
   *
   * @throws AppError `CONFLICT` (no window open for the site, another re-login replaced the one
   *   given, or no sign-in cookie on it).
   */
  async confirm(
    templateId: string,
    siteId: string,
    by: string,
    requestedAt?: number,
  ): Promise<ReloginResponse> {
    const { template, site } = await this.#load(templateId, siteId);
    const run = this.#runs.active(templateId);
    if (run === null || run.view.state !== 'open' || run.view.site_id !== site.siteId) {
      throw healthConflict(`No re-login window is open for ${site.siteId}.`);
    }
    if (requestedAt !== undefined && run.view.requested_at !== requestedAt) throw replaced();
    const jar = (await this.#deps.ops.jar(templateId)) ?? [];
    const learned = learnedCookieNames(run.baseline?.names ?? new Set(), jar, site.siteId);
    const present = new Set(jar.filter((c) => cookieSite(c) === site.siteId).map((c) => c.name));
    const kept = site.learnedCookieNames.filter((n) => present.has(n));
    const names = learned.length > 0 ? learned : kept;
    if (names.length === 0) {
      throw healthConflict(
        `No new cookies on ${site.siteId} since the window opened; sign in there first.`,
      );
    }
    await this.#deps.repos.templateSites.upsert({ ...site, learnedCookieNames: names });
    await this.#runs.succeed(run, template, site.siteId, by, 'confirmed_by_operator');
    return this.#response(run);
  }

  /**
   * `DELETE /templates/{id}/relogin`: closes the window, or drops a queued re-login. With
   * `requestedAt`, only that re-login (a stale tab or an interrupted CLI never cancels a newer one,
   * review #81 L-2).
   */
  async cancel(templateId: string, by: string, requestedAt?: number): Promise<ReloginResponse> {
    const run = this.#runs.active(templateId);
    if (run === null) throw healthConflict('No re-login is queued or open for this template.');
    if (requestedAt !== undefined && run.view.requested_at !== requestedAt) throw replaced();
    await this.#runs.end(run, 'cancelled', null);
    await this.#audit(by, templateId, { site_id: run.view.site_id, cancelled: true });
    return this.#response(run);
  }

  /** **Let agents continue** (D-60); pressing it when agents already continue is harmless. */
  continueAgents(templateId: string): boolean {
    const released = this.#deps.supervisor.pause.release(templateId);
    const run = this.#runs.active(templateId);
    if (run !== null) this.#runs.publish(run, { agents_paused: false });
    return released;
  }

  /**
   * Live-view input to `sessionId` (operators with `templates:login`): allowed while it is the open
   * window of a live-view re-login; the input starts the agents' wait (spec 13 §8.4, review #81 M-2).
   */
  liveInput(sessionId: string): boolean {
    const run = this.#runs.bySession(sessionId);
    if (run === null || run.view.state !== 'open' || run.view.sign_in_via !== 'live_view') {
      return false;
    }
    this.#windows.input(run);
    return true;
  }

  /**
   * A site became signed out (vault auto-relogin, spec 13 §8.4): only with the switch on and the
   * template ready, one try per sign-out; a second sign-out within 24 h of the last try fails.
   */
  signedOut(template: TemplateRecord, site: TemplateSiteRecord): void {
    const vault = this.#vault;
    if (vault === null || site.vaultHandle === null || !site.autoRelogin) return;
    if (this.#deps.packs?.humanOnly(site.packId) === true) return;
    if (template.status !== 'ready' || this.#runs.active(template.templateId) !== null) return;
    const run = this.#runs.begin(template, site, 'vault', 'browserhive', 'filling');
    if (!vault.mayRetry(site)) {
      void this.#runs.end(run, 'failed', 'retry_window');
      return;
    }
    void this.#runVault(vault, template, site, run, 'auto');
  }

  /**
   * The queued → open transition, once per run whoever asks: the first caller opens the window
   * (re-checking the template), the others wait for it (review #81 H-1, L-13).
   */
  async #open(
    run: Running,
    principal: SessionPrincipal,
    letAgentsContinue: boolean,
  ): Promise<void> {
    if (run.opening === null) {
      run.opening = (async () => {
        try {
          const { template, site } = await this.#load(run.templateId, run.view.site_id);
          this.#assertStartable(template);
          if (!this.#runs.current(run)) return;
          await this.#windows.open(run, template, site, principal, letAgentsContinue);
        } catch (err) {
          if (this.#runs.current(run) && run.view.state === 'queued') {
            await this.#runs.end(run, 'failed', 'window_failed');
          }
          throw err;
        }
      })().finally(() => {
        run.opening = null;
      });
    }
    await run.opening;
  }

  async #runVault(
    vault: ReloginVaultFill,
    template: TemplateRecord,
    site: TemplateSiteRecord,
    run: Running,
    trigger: 'manual' | 'auto',
  ): Promise<void> {
    try {
      const outcome = await vault.fill(template, site, trigger, (sessionId) =>
        this.#runs.publish(run, { session_id: sessionId }),
      );
      if (outcome.ok) {
        await this.#runs.succeed(run, template, site.siteId, run.view.requested_by, 'relogin');
      } else {
        await this.#runs.end(run, 'failed', outcome.error);
      }
    } catch (err) {
      this.#deps.logger.warn('vault re-login failed', {
        templateId: template.templateId,
        err: serializeError(err),
      });
      await this.#runs.end(run, 'failed', 'internal').catch(() => undefined);
    }
  }

  #assertStartable(template: TemplateRecord): void {
    if (template.status === 'disabled') throw disabled(template.name);
    if (template.status === 'recording') {
      throw healthConflict(
        `Template '${template.name}' is still being set up; finish its recording first.`,
      );
    }
    if (this.#deps.ops.recordingOf(template.templateId) !== null) {
      throw healthConflict(
        'A recording window is open for this template; finish or cancel it first.',
      );
    }
  }

  #vaultFor(site: TemplateSiteRecord): ReloginVaultFill {
    if (this.#deps.packs?.humanOnly(site.packId) === true) {
      const message = `${site.siteId} is signed in by a person only (its site pack is human_only); use a window`;
      throw validationFailed([{ path: 'method', message, code: 'human_only' }]);
    }
    if (this.#vault === null || site.vaultHandle === null) {
      const message =
        this.#vault === null
          ? 'the vault is not configured on this server'
          : `${site.siteId} has no linked vault binding`;
      throw validationFailed([{ path: 'method', message, code: 'no_binding' }]);
    }
    if (site.form === null) {
      throw validationFailed([
        {
          path: 'method',
          message: `${site.siteId} has no sign-in form selectors`,
          code: 'no_form',
        },
      ]);
    }
    return this.#vault;
  }

  async #load(
    templateId: string,
    raw: string,
  ): Promise<{ template: TemplateRecord; site: TemplateSiteRecord }> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    const id = registrableDomain(raw) || raw;
    const sites = await this.#deps.repos.templateSites.list(templateId);
    const site = sites.find((s) => s.siteId === id);
    if (site === undefined) {
      throw validationFailed([
        { path: 'site_id', message: `${raw} is not a site of this template`, code: 'unknown_site' },
      ]);
    }
    return { template, site };
  }

  #response(run: Running): ReloginResponse {
    const live = this.#runs.session(run) === null ? null : run.view.session_id;
    return { session_id: live, relogin: { ...run.view } };
  }

  async #audit(
    by: string,
    templateId: string,
    details: JsonObject,
    action = 'template.relogin',
  ): Promise<void> {
    await this.#deps.repos.operatorActions.append({
      eventId: this.#deps.ids.eventId(),
      principalId: by,
      action,
      resourceKind: 'template',
      resourceId: templateId,
      details,
      occurredAt: this.#deps.clock.now(),
    });
  }
}

/** The re-login a caller named was replaced by a newer one (review #81 L-2). */
function replaced(): AppError<'CONFLICT'> {
  return healthConflict(
    'Another re-login replaced the one you started; reload to see the current one.',
  );
}

/** @module app/templates/template-recording — recording a template's sign-ins through REST and the CLI (spec 13 §7.1 step 5, §7.2, §11.1): the sign-in window, **I'm signed in** (learned cookie names), unlisted sign-ins, Finish (version 1) and Cancel, plus the T1a host routes (remove a sign-in, clear saved passwords). */

import type {
  FinishRecordingResponse,
  StartRecordingResponse,
  TemplateSiteView,
} from '@browserhive/contracts/http';
import type { SessionPrincipal } from '../../domain/session/principal.ts';
import { jarNames, learnedCookieNames, unlistedDomains } from '../../domain/templates/sign-ins.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateRecord,
  TemplateSiteHealthRecord,
  TemplateSiteRecord,
  UnitOfWork,
} from '../../ports/persistence/index.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import type { TemplateHostOps, TemplateRuntime } from '../../ports/template-runtime.ts';
import { disabled, notFoundForOperator, validationFailed } from './template-errors.ts';
import type { TemplateStateService } from './template-state.ts';
import { toHostView, toSiteView, toTemplateView } from './views.ts';

/** Collaborators of {@link TemplateRecordingService}. */
export interface TemplateRecordingDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'operatorActions'>;
  readonly uow: UnitOfWork;
  readonly runtime: TemplateRuntime;
  readonly ops: TemplateHostOps;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Versions (T1b): Finish writes version 1; a removed sign-in leaves the checkpoint too. */
  readonly state?: Pick<TemplateStateService, 'saveVersion' | 'forgetDomain'>;
  /** The template's summary changed (`template.changed`). */
  readonly changed?: (templateId: string) => void;
}

/** One removed sign-in as REST reports it. */
export type RemovedSignIn = FinishRecordingResponse['removed_sign_ins'][number];

/** `CONFLICT` with an operator-facing message. */
function conflict(message: string): AppError<'CONFLICT'> {
  return new AppError('CONFLICT', {}, { publicMessage: message });
}

/** The operator's recording workflow. */
export class TemplateRecordingService {
  readonly #deps: TemplateRecordingDeps;
  readonly #log: Logger;
  /** Cookie names (`<site>\t<name>`) when each template's recording window opened. */
  readonly #baselines = new Map<string, ReadonlySet<string>>();

  constructor(deps: TemplateRecordingDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.recording' });
  }

  /**
   * `POST /templates/{id}/recording`: opens the sign-in window on the BrowserHive machine (or raises
   * the open one) and snapshots the jar's cookie names.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `TEMPLATE_DISABLED`, `VALIDATION_FAILED` (a site that is
   *   not one of the template's), and the host's start refusals.
   */
  async start(
    templateId: string,
    request: { readonly sites?: readonly string[] },
    principal: SessionPrincipal,
  ): Promise<StartRecordingResponse> {
    const { template, sites } = await this.#load(templateId);
    if (template.status === 'disabled') throw disabled(template.name);
    const siteIds = this.#chosenSites(sites, request.sites);
    const session = await this.#deps.ops.openRecording({ template, sites, siteIds, principal });
    if (!this.#baselines.has(templateId)) {
      const jar = (await this.#deps.ops.jar(templateId)) ?? [];
      this.#baselines.set(templateId, jarNames(jar));
      await this.#audit(principal.subject, 'template.record.start', templateId, {
        session_id: session.id,
        sites: [...siteIds],
      });
    }
    this.#log.info('recording window open', { templateId, sessionId: session.id });
    return { session_id: session.id, host: toHostView(this.#deps.runtime.host(templateId)) };
  }

  /**
   * `POST /templates/{id}/recording/confirm` (**I'm signed in**): the names added on the site since
   * the window opened become its learned cookie names, and the site reads signed in.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `CONFLICT` (no recording open, or no new cookie on the
   *   site), `VALIDATION_FAILED` (not a site of the template).
   */
  async confirm(templateId: string, siteId: string, by: string): Promise<TemplateSiteView> {
    const { sites } = await this.#load(templateId);
    const site = this.#site(sites, siteId);
    const baseline = this.#baselines.get(templateId);
    const jar =
      this.#deps.ops.recordingOf(templateId) === null ? null : await this.#deps.ops.jar(templateId);
    if (baseline === undefined || jar === null) {
      throw conflict(`No sign-in window is open for this template; start a recording first.`);
    }
    const learned = learnedCookieNames(baseline, jar, site.siteId);
    const present = new Set(jar.map((c) => c.name));
    const kept = site.learnedCookieNames.filter((n) => present.has(n));
    const names = learned.length > 0 ? learned : kept;
    if (names.length === 0) {
      throw conflict(
        `No new cookies on ${site.siteId} since the sign-in window opened; sign in there first.`,
      );
    }
    const now = this.#deps.clock.now();
    const updated: TemplateSiteRecord = {
      ...site,
      learnedCookieNames: names,
      health: this.#health(site.health, 'signed_in', 'confirmed_by_operator', now),
    };
    await this.#deps.repos.templateSites.upsert(updated);
    await this.#audit(by, 'template.record.confirm', templateId, {
      site_id: site.siteId,
      learned_cookie_names: [...names],
    });
    return toSiteView(updated);
  }

  /**
   * `POST /templates/{id}/recording/finish`: removes the chosen unlisted sign-ins, marks every
   * site not confirmed signed out, sets the template `ready`, closes the window and writes version
   * 1 (`reason: 'recording'`) from the running browser (`version: null` when it is not running or
   * no template key resolves).
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `CONFLICT` (not recording), `VALIDATION_FAILED` (a
   *   removal names a site of the template).
   */
  async finish(
    templateId: string,
    request: { readonly removeSignIns?: readonly string[] },
    by: string,
  ): Promise<FinishRecordingResponse> {
    const { template, sites } = await this.#load(templateId);
    const open = this.#deps.ops.recordingOf(templateId) !== null;
    if (template.status !== 'recording' && !open) {
      throw conflict(`Template '${template.name}' is not being recorded.`);
    }
    const removals = this.#removals(sites, request.removeSignIns ?? []);
    // The window's pages close first, so none of them writes a removed sign-in back.
    await this.#deps.ops.closeRecording(templateId);
    const removed: RemovedSignIn[] = [];
    for (const domain of removals) {
      removed.push(await this.#remove(template, domain));
    }
    const now = this.#deps.clock.now();
    const finished = sites.map((site) =>
      site.health.state === 'signed_in'
        ? site
        : { ...site, health: this.#health(site.health, 'signed_out', 'not_confirmed', now) },
    );
    const ready = await this.#deps.uow.transaction(async (repos) => {
      for (const site of finished) await repos.templateSites.upsert(site);
      const updated =
        template.status === 'recording'
          ? await repos.templates.update(template.templateId, { status: 'ready' }, template.version)
          : template;
      await repos.operatorActions.append({
        eventId: this.#deps.ids.eventId(),
        principalId: by,
        action: 'template.record.finish',
        resourceKind: 'template',
        resourceId: templateId,
        details: {
          signed_in: finished.filter((s) => s.health.state === 'signed_in').map((s) => s.siteId),
          removed_sign_ins: removed.map((r) => ({ ...r })),
        },
        occurredAt: now,
      });
      return updated;
    });
    this.#baselines.delete(templateId);
    const version = await this.#version(templateId, by);
    this.#log.info('recording finished', { templateId, removed: removals.length, version });
    this.#deps.changed?.(templateId);
    const current = (await this.#deps.repos.templates.get(templateId)) ?? ready;
    return { template: toTemplateView(current, finished), version, removed_sign_ins: removed };
  }

  /** `DELETE /templates/{id}/recording`: closes the window; the template is unchanged. */
  async cancel(templateId: string, by: string): Promise<void> {
    await this.#load(templateId);
    await this.#deps.ops.closeRecording(templateId);
    this.#baselines.delete(templateId);
    await this.#audit(by, 'template.record.cancel', templateId, {});
  }

  /** `POST /templates/{id}/domains/{domain}/remove-sign-in` (spec 13 §2.3). */
  async removeSignIn(templateId: string, domain: string, by: string): Promise<RemovedSignIn> {
    const { template, sites } = await this.#load(templateId);
    const [site] = this.#removals(sites, [domain]);
    if (site === undefined) throw notFoundForOperator(templateId);
    const removed = await this.#remove(template, site);
    await this.#audit(by, 'template.signin.remove', templateId, { ...removed });
    return removed;
  }

  /** Version 1 of a finished recording, from the running browser; `null` when it cannot be written. */
  async #version(templateId: string, by: string): Promise<number | null> {
    if (this.#deps.state === undefined) return null;
    try {
      return await this.#deps.state.saveVersion(templateId, { reason: 'recording', by });
    } catch (err) {
      this.#log.warn('recording version failed', { templateId, err: serializeError(err) });
      return null;
    }
  }

  /** Removes one sign-in; origins left with data are a warning, never silent (spec 13 §2.3). */
  async #remove(template: TemplateRecord, domain: string): Promise<RemovedSignIn> {
    const result = await this.#deps.ops.removeSignIn(template, domain);
    await this.#deps.state?.forgetDomain(template.templateId, domain);
    if (result.unclearedOrigins.length > 0) {
      this.#log.warn('sign-in removal incomplete', {
        templateId: template.templateId,
        domain,
        uncleared: [...result.unclearedOrigins],
      });
    }
    return {
      domain,
      cookies_removed: result.cookiesRemoved,
      origins_cleared: [...result.origins],
      uncleared_origins: [...result.unclearedOrigins],
    };
  }

  /** `POST /templates/{id}/host/clear-profile-secrets` (spec 13 §3.1). */
  async clearProfileSecrets(templateId: string, by: string): Promise<void> {
    const { template } = await this.#load(templateId);
    await this.#deps.ops.clearProfileSecrets(template);
    await this.#audit(by, 'template.profile_secrets.clear', templateId, {});
  }

  /** The unlisted sign-ins of a running template browser (`[]` when it is stopped). */
  async unlisted(templateId: string, sites: readonly TemplateSiteRecord[]): Promise<string[]> {
    const jar = await this.#deps.ops.jar(templateId);
    return jar === null
      ? []
      : unlistedDomains(
          jar,
          sites.map((s) => s.siteId),
        );
  }

  // --- helpers ----------------------------------------------------------------------------------

  async #load(
    templateId: string,
  ): Promise<{ template: TemplateRecord; sites: readonly TemplateSiteRecord[] }> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    return { template, sites: await this.#deps.repos.templateSites.list(templateId) };
  }

  #site(sites: readonly TemplateSiteRecord[], raw: string): TemplateSiteRecord {
    const id = registrableDomain(raw) || raw;
    const site = sites.find((s) => s.siteId === id);
    if (site === undefined) {
      throw validationFailed([
        { path: 'site_id', message: `${raw} is not a site of this template`, code: 'unknown_site' },
      ]);
    }
    return site;
  }

  #chosenSites(
    sites: readonly TemplateSiteRecord[],
    requested: readonly string[] | undefined,
  ): readonly string[] {
    if (requested === undefined) return sites.filter((s) => s.enabled).map((s) => s.siteId);
    return [...new Set(requested.map((raw) => this.#site(sites, raw).siteId))];
  }

  /** Registrable domains to remove; a site of the template is refused (its sign-in is the point). */
  #removals(sites: readonly TemplateSiteRecord[], raw: readonly string[]): string[] {
    const own = new Set(sites.map((s) => s.siteId));
    const out = new Set<string>();
    for (const value of raw) {
      const domain = registrableDomain(value);
      if (domain === '' || own.has(domain)) {
        throw validationFailed([
          {
            path: 'remove_sign_ins',
            message: `${value} is ${domain === '' ? 'not a domain' : 'a site of this template'}`,
            code: 'invalid_domain',
          },
        ]);
      }
      out.add(domain);
    }
    return [...out];
  }

  #health(
    previous: TemplateSiteHealthRecord,
    state: 'signed_in' | 'signed_out',
    reason: string,
    now: number,
  ): TemplateSiteHealthRecord {
    return {
      ...previous,
      state,
      reason,
      checkedAt: now,
      changedAt: previous.state === state ? previous.changedAt : now,
      consecutiveInconclusive: 0,
    };
  }

  async #audit(by: string, action: string, templateId: string, details: JsonObject): Promise<void> {
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

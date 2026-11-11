/** @module app/templates/template-service — session templates as data: create, list, read and delete for operators; listing and the launch gate for agents (spec 13 §2, §5.1–§5.3, §6.1, §11.1; D-49, D-52). The host side (hosts, windows, admission) is behind `TemplateRuntime`. */

import type {
  DeleteTemplateResponse,
  Template,
  TemplateDetailResponse,
  TemplateInput,
  TemplatesPage,
  TemplatesQuery,
} from '@browserhive/contracts/http';
import type { AgentTemplate } from '@browserhive/contracts/tools';
import type { SessionClientInfo } from '../../domain/session/client-info.ts';
import type { CreateSessionInput } from '../../domain/session/create-request.ts';
import type { SessionPrincipal } from '../../domain/session/principal.ts';
import type { Session } from '../../domain/session/session.ts';
import {
  buildTemplate,
  pinnedIdentity,
  type TemplateDefaults,
  validateTemplateInput,
} from '../../domain/templates/create.ts';
import { applyTemplateLaunchOptions } from '../../domain/templates/launch-options.ts';
import {
  availabilityOf,
  effectiveCap,
  isSessionSealed,
  type PageCaps,
  pageCaps,
  sealingFor,
  templateGate,
} from '../../domain/templates/model.ts';
import { unlistedDomains } from '../../domain/templates/sign-ins.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DegradationReporter } from '../../ports/degradation-reporter.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { TemplateGeoResolver } from '../../ports/geo-seed-resolver.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  Repositories,
  TemplateRecord,
  TemplateVersionRepository,
  UnitOfWork,
} from '../../ports/persistence/index.ts';
import type { TemplateFiles } from '../../ports/template-files.ts';
import type { TemplateHostOps, TemplateRuntime } from '../../ports/template-runtime.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { launchDeclaredHarnessOf, launchHarnessOf } from '../sessions/metadata.ts';
import {
  deleteRunning,
  disabled,
  inUse,
  invalidArguments,
  nameTaken,
  notFoundForAgent,
  notFoundForOperator,
  operationRunning,
  validationFailed,
} from './template-errors.ts';
import { pageTemplates } from './template-list.ts';
import { TemplateLocks } from './template-locks.ts';
import { publishTemplateChanged, readTemplates, storedUnlisted } from './template-reads.ts';
import { toAgentTemplate, toTemplateDetail, toTemplateSummary, toTemplateView } from './views.ts';

/** Server configuration the service reads. */
export interface TemplateServiceConfig {
  /** `templates` (spec 08 §5.9): `false` hides `list_templates` and every template from agents. */
  readonly enabled: boolean;
  /** `auth=token` requires an explicit access choice at creation (spec 13 §6.1). */
  readonly authMode: 'off' | 'token';
  /** `templateMaxPagesPerHost`. */
  readonly maxPagesPerHost: number;
  /** Server defaults for fields a new template leaves out. */
  readonly defaults: TemplateDefaults;
}

/** Dependencies of {@link TemplateService}. */
export interface TemplateServiceDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'operatorActions'>;
  readonly uow: UnitOfWork;
  readonly runtime: TemplateRuntime;
  /** The running browser's live facts for the detail view; absent = none (no hosts). */
  readonly ops?: Pick<TemplateHostOps, 'jar' | 'sharedWindows' | 'hold'>;
  readonly geo: TemplateGeoResolver;
  readonly files: TemplateFiles;
  readonly ids: Pick<IdGenerator, 'opaque' | 'eventId'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Unreadable rows skipped by `list_templates` (`TEMPLATE_ROW_UNREADABLE`). */
  readonly degradations: DegradationReporter;
  readonly config: TemplateServiceConfig;
  /** The `templates` topic (`template.changed`, `template.removed`). */
  readonly bus?: EventPublisher<DomainEvents>;
  /** The newest version's summary (unlisted sign-ins of a stopped browser, spec 13 §2.3). */
  readonly versions?: Pick<TemplateVersionRepository, 'list'>;
}

/** The caller of an agent-facing operation: the principal and the call's resolved client (harness). */
export interface TemplateCaller {
  readonly principal: SessionPrincipal;
  readonly client: SessionClientInfo | null;
}

/** Characters of the seed that feeds the template's fingerprint for its life (spec 13 §2.2). */
const SEED_LENGTH = 21;
/** Characters after `tp-` (D-05). */
const TEMPLATE_ID_LENGTH = 10;

/** Session templates: the operator's CRUD and the agent's list and launch gate. */
export class TemplateService {
  readonly #deps: TemplateServiceDeps;
  readonly #log: Logger;
  readonly #locks = new TemplateLocks();

  constructor(deps: TemplateServiceDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates' });
  }

  /** `templates` (spec 08 §5.9). */
  get enabled(): boolean {
    return this.#deps.config.enabled;
  }

  /** Agent page limits of a template's host (spec 13 §6.3; read by `TemplateAdmission`, T1a-2). */
  pageCaps(template: TemplateRecord): PageCaps {
    return pageCaps(this.#deps.config.maxPagesPerHost, effectiveCap(template));
  }

  // --- operators (REST, spec 13 §11.1) ----------------------------------------------------------

  /**
   * `POST /templates`: a new template in `recording`, with its sites and pinned identity.
   *
   * @throws AppError `VALIDATION_FAILED`, `TEMPLATE_NAME_TAKEN`.
   */
  async create(input: TemplateInput, owner: string): Promise<Template> {
    const { config, ids, clock, geo } = this.#deps;
    const validated = validateTemplateInput(input, { authMode: config.authMode });
    if (!validated.ok) throw validationFailed(validated.issues);
    if ((await this.#deps.repos.templates.getByName(input.name)) !== null) {
      throw nameTaken(input.name);
    }
    const resolved = await geo.resolve({
      ...(input.locale !== undefined && { locale: input.locale }),
      ...(input.timezone_id !== undefined && { timezoneId: input.timezone_id }),
    });
    const identity = pinnedIdentity(ids.opaque(SEED_LENGTH), resolved, input.geolocation);
    const now = clock.now();
    const { template, sites } = buildTemplate(input, validated.value, {
      templateId: `tp-${ids.opaque(TEMPLATE_ID_LENGTH)}`,
      owner,
      now,
      identity,
      defaults: config.defaults,
      authMode: config.authMode,
    });
    await this.#deps.uow.transaction(async (repos) => {
      await repos.templates.insert(template);
      for (const site of sites) await repos.templateSites.upsert(site);
      await repos.operatorActions.append({
        eventId: ids.eventId(),
        principalId: owner,
        action: 'template.create',
        resourceKind: 'template',
        resourceId: template.templateId,
        details: { name: template.name, sites: sites.map((s) => s.siteId) },
        occurredAt: now,
      });
    });
    this.#log.info('template created', {
      templateId: template.templateId,
      name: template.name,
      sites: sites.length,
    });
    this.publishChanged(template.templateId);
    return toTemplateView(template, sites);
  }

  /** `GET /templates`: every template as a summary, filtered, sorted and paged (spec 13 §11.1). */
  async list(query: TemplatesQuery): Promise<TemplatesPage> {
    const { templates, sites } = await readTemplates(this.#deps.repos, null);
    const rows = templates.map((t) => {
      const own = sites.get(t.templateId) ?? [];
      return {
        record: t,
        sites: own,
        summary: toTemplateSummary(t, own, this.#deps.runtime.host(t.templateId)),
      };
    });
    return pageTemplates(rows, query, this.#deps.clock.now());
  }

  /**
   * `GET /templates/{template_id}`.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`.
   */
  async get(templateId: string): Promise<TemplateDetailResponse> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    const sites = await this.#deps.repos.templateSites.list(templateId);
    const ops = this.#deps.ops;
    const host = this.#deps.runtime.host(templateId);
    const jar = (await ops?.jar(templateId)) ?? null;
    const shared = (await ops?.sharedWindows(templateId)) ?? [];
    const own = new Set(sites.map((s) => s.siteId));
    const stored = jar === null ? await storedUnlisted(this.#deps.versions, templateId, own) : [];
    return toTemplateDetail(
      template,
      sites,
      { ...host, sharedWindows: shared },
      this.#deps.runtime.liveSessions(templateId).length,
      this.#deps.clock.now(),
      {
        unlistedDomains:
          jar === null
            ? stored
            : unlistedDomains(
                jar,
                sites.map((s) => s.siteId),
              ),
      },
    );
  }

  /**
   * `DELETE /templates/{template_id}`: stops the host, deletes the rows and `templates/<id>/`. With
   * live sessions it needs `force`, which closes them (`closed_reason: 'operator'`). Deleting does
   * not sign out at the sites.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `TEMPLATE_IN_USE`.
   */
  async remove(
    templateId: string,
    options: { readonly force: boolean; readonly by: string },
  ): Promise<DeleteTemplateResponse> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    // From here no launch of this template starts (`launch` checks synchronously before it begins).
    const release = this.#locks.beginDelete(templateId);
    if (release === null) throw deleteRunning(templateId);
    // A restore, seed or clearing of saved passwords must finish first (review #79 H-1).
    const hold = this.#deps.ops === undefined ? null : this.#deps.ops.hold(templateId);
    if (this.#deps.ops !== undefined && hold === null) {
      release();
      throw operationRunning(templateId);
    }
    try {
      const busy =
        this.#deps.runtime.liveSessions(templateId).length + this.#locks.inFlight(templateId);
      if (busy > 0 && !options.force) throw inUse(templateId, busy);
      // With force, launches already past the gate finish first; shutdown then closes them too.
      await this.#locks.settled(templateId);
      const closed = await this.#deps.runtime.shutdown(templateId);
      const now = this.#deps.clock.now();
      await this.#deps.uow.transaction(async (repos) => {
        await repos.templates.remove(templateId);
        await repos.operatorActions.append({
          eventId: this.#deps.ids.eventId(),
          principalId: options.by,
          action: 'template.delete',
          resourceKind: 'template',
          resourceId: templateId,
          details: { name: template.name, force: options.force, closed_sessions: [...closed] },
          occurredAt: now,
        });
      });
      const deletedBytes = await this.#removeFiles(templateId);
      this.#deps.bus?.publish('template.removed', {
        type: 'template.removed',
        template_id: templateId,
      });
      this.#log.info('template deleted', {
        templateId,
        name: template.name,
        closedSessions: closed.length,
        deletedBytes,
      });
      return { ok: true, closed_sessions: [...closed], deleted_bytes: deletedBytes };
    } finally {
      hold?.release();
      release();
    }
  }

  // --- agents (MCP, spec 13 §5) -----------------------------------------------------------------

  /**
   * `list_templates`: the templates the caller may launch, sorted by name (spec 13 §5.1). A template
   * the caller may not use, or one still being recorded, is absent, never marked.
   */
  async listForAgent(caller: TemplateCaller): Promise<readonly AgentTemplate[]> {
    if (!this.enabled) return [];
    const { templates, sites } = await readTemplates(this.#deps.repos, {
      log: this.#log,
      degradations: this.#deps.degradations,
    });
    const subject = this.#subject(caller);
    const out: AgentTemplate[] = [];
    for (const template of templates) {
      if (!templateGate(template, subject).allowed) continue;
      const own = sites.get(template.templateId) ?? [];
      const host = this.#deps.runtime.host(template.templateId);
      const sealing = sealingFor(template.unseal, caller.principal.subject);
      out.push(
        toAgentTemplate(
          template,
          own,
          availabilityOf(template, own, host),
          isSessionSealed(sealing),
        ),
      );
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * `launch_session({template})` (spec 13 §3.7 `validate`, §5.3, §6.3 admission order): resolve the
   * template by name, check access (unknown, unauthorized and still-recording all answer
   * `TEMPLATE_NOT_FOUND`, the reason goes to the log only), refuse a disabled template, apply the
   * launch option rules, then hand the launch to the runtime.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `TEMPLATE_DISABLED`, `INVALID_ARGUMENTS`, and what the
   *   runtime throws (`TEMPLATE_UNAVAILABLE`, `TEMPLATE_BUSY`, `SESSION_LIMIT_REACHED`, …).
   */
  async launch(
    name: string,
    input: CreateSessionInput,
    caller: TemplateCaller,
    signal?: AbortSignal,
  ): Promise<Session> {
    if (!this.enabled) throw notFoundForAgent(name);
    const template = await this.#deps.repos.templates.getByName(name);
    if (template === null) throw notFoundForAgent(name);
    const gate = templateGate(template, this.#subject(caller));
    if (!gate.allowed) {
      this.#log.info('template launch refused', {
        templateId: template.templateId,
        reason: gate.reason,
        principal: caller.principal.subject,
      });
      throw notFoundForAgent(name);
    }
    if (template.status === 'disabled') throw disabled(name);
    const sealing = sealingFor(template.unseal, caller.principal.subject);
    const options = applyTemplateLaunchOptions(template, input, sealing);
    if (!options.ok) throw invalidArguments(options.issues);
    const sites = await this.#deps.repos.templateSites.list(template.templateId);
    // Checked and registered with no await in between, so a delete either sees this launch in
    // flight or has started first and this launch finds the template gone.
    if (this.#locks.isDeleting(template.templateId)) throw notFoundForAgent(name);
    const release = this.#locks.beginLaunch(template.templateId);
    try {
      return await this.#deps.runtime.launch(
        {
          template,
          sites,
          slug: input.slug,
          connectionId: input.connectionId ?? null,
          client: caller.client,
          principal: caller.principal,
          sealing,
          sealed: isSessionSealed(sealing),
          settings: options.settings,
        },
        signal,
      );
    } finally {
      release();
    }
  }

  /** `<data-dir>/templates/<id>` (the data-directory reveal). */
  dirOf(templateId: string): string {
    return this.#deps.files.dirOf(templateId);
  }

  /** Publishes `template.changed` with the template's summary now (never throws). */
  publishChanged(templateId: string): void {
    publishTemplateChanged(this.#deps, templateId, this.#log);
  }

  // --- helpers ----------------------------------------------------------------------------------

  #subject(caller: TemplateCaller) {
    return {
      principal: caller.principal.subject,
      harness: launchHarnessOf(caller.client),
      declared: launchDeclaredHarnessOf(caller.client),
    };
  }

  /** Deletes `templates/<id>/`; the rows are gone already, so a failure is logged, never thrown. */
  async #removeFiles(templateId: string): Promise<number> {
    try {
      return await this.#deps.files.removeTemplateDir(templateId);
    } catch (cause) {
      this.#log.warn('template dir not removed', {
        templateId,
        err: serializeError(cause),
      });
      return 0;
    }
  }
}

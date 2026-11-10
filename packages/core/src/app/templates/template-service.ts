/** @module app/templates/template-service — session templates as data: create, list, read and delete for operators; listing and the launch gate for agents (spec 13 §2, §5.1–§5.3, §6.1, §11.1; D-49, D-52). The host side (hosts, windows, admission) is behind `TemplateRuntime`. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import type {
  DeleteTemplateResponse,
  Template,
  TemplateDetailResponse,
  TemplateInput,
  TemplateSummary,
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
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { TemplateGeoResolver } from '../../ports/geo-seed-resolver.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  PinnedIdentityRecord,
  Repositories,
  TemplateRecord,
  TemplateSiteRecord,
  UnitOfWork,
} from '../../ports/persistence/index.ts';
import type { TemplateFiles } from '../../ports/template-files.ts';
import type { TemplateRuntime } from '../../ports/template-runtime.ts';
import { launchDeclaredHarnessOf, launchHarnessOf } from '../sessions/metadata.ts';
import { decodeListCursor, encodeListCursor } from './list-cursor.ts';
import {
  toAgentTemplate,
  toHostView,
  toSiteView,
  toTemplateSummary,
  toTemplateView,
} from './views.ts';

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
  readonly geo: TemplateGeoResolver;
  readonly files: TemplateFiles;
  readonly ids: Pick<IdGenerator, 'opaque' | 'eventId'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: TemplateServiceConfig;
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

function notFoundForAgent(name: string): AppError<'TEMPLATE_NOT_FOUND'> {
  const details = { template: name };
  return new AppError('TEMPLATE_NOT_FOUND', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_NOT_FOUND.message, details),
  });
}

function notFoundForOperator(templateId: string): AppError<'TEMPLATE_NOT_FOUND'> {
  return new AppError(
    'TEMPLATE_NOT_FOUND',
    { template: templateId },
    { publicMessage: `No session template '${templateId}'.` },
  );
}

type SortKey = TemplatesQuery['sort'];

function sortValue(summary: TemplateSummary, key: SortKey, createdAt: number): number | string {
  switch (key) {
    case 'name':
      return summary.name;
    case 'created_at':
      return createdAt;
    case 'last_used_at':
      return summary.last_used_at ?? 0;
    case 'in_use':
      return summary.in_use;
  }
}

function compare(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Session templates: the operator's CRUD and the agent's list and launch gate. */
export class TemplateService {
  readonly #deps: TemplateServiceDeps;
  readonly #log: Logger;

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
    if (!validated.ok) {
      const first = validated.issues[0];
      throw new AppError(
        'VALIDATION_FAILED',
        { issues: [...validated.issues] },
        {
          publicMessage:
            first === undefined ? 'Invalid template.' : `${first.path}: ${first.message}`,
        },
      );
    }
    if ((await this.#deps.repos.templates.getByName(input.name)) !== null) {
      throw new AppError(
        'TEMPLATE_NAME_TAKEN',
        { name: input.name },
        {
          publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_NAME_TAKEN.message, {
            name: input.name,
          }),
        },
      );
    }
    const resolved = await geo.resolve({
      ...(input.locale !== undefined && { locale: input.locale }),
      ...(input.timezone_id !== undefined && { timezoneId: input.timezone_id }),
    });
    const identity: PinnedIdentityRecord = {
      seed: ids.opaque(SEED_LENGTH),
      locale: resolved.locale,
      languages: resolved.languages,
      timezoneId: resolved.timezoneId,
      countryCode: resolved.countryCode,
      ...(input.geolocation !== undefined && {
        geolocation: {
          latitude: input.geolocation.latitude,
          longitude: input.geolocation.longitude,
          ...(input.geolocation.accuracy !== undefined && {
            accuracy: input.geolocation.accuracy,
          }),
        },
      }),
    };
    const now = clock.now();
    const { template, sites } = buildTemplate(input, validated.value, {
      templateId: `tp-${ids.opaque(TEMPLATE_ID_LENGTH)}`,
      owner,
      now,
      identity,
      defaults: config.defaults,
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
    return toTemplateView(template, sites);
  }

  /** `GET /templates`: every template as a summary, filtered, sorted and paged (spec 13 §11.1). */
  async list(query: TemplatesQuery): Promise<TemplatesPage> {
    const { templates, sites } = await this.#everything();
    const rows = templates.map((t) => {
      const own = sites.get(t.templateId) ?? [];
      return {
        record: t,
        sites: own,
        summary: toTemplateSummary(t, own, this.#deps.runtime.host(t.templateId)),
      };
    });
    const facets = {
      status: this.#facet(rows.map((r) => r.record.status)),
      host_state: this.#facet(rows.map((r) => r.summary.host.state)),
      health: this.#facet(rows.flatMap((r) => r.sites.map((s) => s.health.state))),
    };
    const q = query.q?.toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (query.status === undefined || query.status.includes(r.record.status)) &&
        (query.host_state === undefined || query.host_state.includes(r.summary.host.state)) &&
        (query.site === undefined || r.sites.some((s) => s.siteId === query.site)) &&
        (q === undefined ||
          r.record.name.includes(q) ||
          r.record.displayName.toLowerCase().includes(q) ||
          r.record.description.toLowerCase().includes(q)),
    );
    const direction = query.dir === 'asc' ? 1 : -1;
    const keyed = filtered
      .map((r) => ({ ...r, key: sortValue(r.summary, query.sort, r.record.createdAt) }))
      .sort(
        (a, b) =>
          direction * compare(a.key, b.key) ||
          direction * a.record.templateId.localeCompare(b.record.templateId),
      );
    const cursor = decodeListCursor(query.cursor);
    const start =
      cursor === null
        ? 0
        : keyed.findIndex(
            (r) =>
              direction * compare(r.key, cursor.key) > 0 ||
              (compare(r.key, cursor.key) === 0 &&
                direction * r.record.templateId.localeCompare(cursor.id) > 0),
          );
    const from = start < 0 ? keyed.length : start;
    const pageRows = keyed.slice(from, from + query.limit);
    const last = pageRows.at(-1);
    const more = from + query.limit < keyed.length;
    return {
      data: pageRows.map((r) => r.summary),
      page: {
        next_cursor:
          more && last !== undefined
            ? encodeListCursor({ key: last.key, id: last.record.templateId })
            : null,
        limit: query.limit,
        ...(query.total && { total: keyed.length }),
      },
      facets,
      applied: {
        filters: {
          ...(query.status !== undefined && { status: query.status }),
          ...(query.host_state !== undefined && { host_state: query.host_state }),
          ...(query.site !== undefined && { site: query.site }),
          ...(query.q !== undefined && { q: query.q }),
        },
        sort: { key: query.sort, dir: query.dir },
      },
      meta: { now: this.#deps.clock.now() },
    };
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
    const host = this.#deps.runtime.host(templateId);
    return {
      template: toTemplateView(template, sites),
      host: toHostView(host),
      sites: sites.map(toSiteView),
      sessions_live: this.#deps.runtime.liveSessions(templateId).length,
      parked_pages: host.parkedPages.map((p) => ({
        target_id: p.targetId,
        url: p.url,
        title: p.title,
        opened_at: p.openedAt,
      })),
      shared_windows: host.sharedWindows.map((w) => ({
        window_id: w.windowId,
        session_ids: [...w.sessionIds],
      })),
      // Computed from version summaries (spec 13 §2.3), which arrive with T1b.
      unlisted_domains: [],
      now: this.#deps.clock.now(),
    };
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
    const live = this.#deps.runtime.liveSessions(templateId);
    if (live.length > 0 && !options.force) {
      const details = { template_id: templateId, live_sessions: live.length };
      throw new AppError('TEMPLATE_IN_USE', details, {
        publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_IN_USE.message, details),
      });
    }
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
    this.#log.info('template deleted', {
      templateId,
      name: template.name,
      closedSessions: closed.length,
      deletedBytes,
    });
    return { ok: true, closed_sessions: [...closed], deleted_bytes: deletedBytes };
  }

  // --- agents (MCP, spec 13 §5) -----------------------------------------------------------------

  /**
   * `list_templates`: the templates the caller may launch, sorted by name (spec 13 §5.1). A template
   * the caller may not use, or one still being recorded, is absent, never marked.
   */
  async listForAgent(caller: TemplateCaller): Promise<readonly AgentTemplate[]> {
    if (!this.enabled) return [];
    const { templates, sites } = await this.#everything();
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
    if (template.status === 'disabled') {
      const details = { template: name, reason: 'disabled' as const };
      throw new AppError('TEMPLATE_DISABLED', details, {
        publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_DISABLED.message, details),
      });
    }
    const sealing = sealingFor(template.unseal, caller.principal.subject);
    const options = applyTemplateLaunchOptions(template, input, sealing);
    if (!options.ok) {
      const first = options.issues[0];
      throw new AppError(
        'INVALID_ARGUMENTS',
        { issues: [...options.issues] },
        {
          publicMessage:
            first === undefined ? 'invalid arguments' : `${first.path}: ${first.message}`,
        },
      );
    }
    const sites = await this.#deps.repos.templateSites.list(template.templateId);
    return this.#deps.runtime.launch(
      {
        template,
        sites,
        input,
        principal: caller.principal,
        client: caller.client,
        sealing,
        sealed: isSessionSealed(sealing),
        settings: options.settings,
      },
      signal,
    );
  }

  // --- helpers ----------------------------------------------------------------------------------

  #subject(caller: TemplateCaller) {
    return {
      principal: caller.principal.subject,
      harness: launchHarnessOf(caller.client),
      declared: launchDeclaredHarnessOf(caller.client),
    };
  }

  async #everything(): Promise<{
    readonly templates: readonly TemplateRecord[];
    readonly sites: ReadonlyMap<string, readonly TemplateSiteRecord[]>;
  }> {
    const [templates, all] = await Promise.all([
      this.#deps.repos.templates.listAll(),
      this.#deps.repos.templateSites.listAll(),
    ]);
    const sites = new Map<string, TemplateSiteRecord[]>();
    for (const site of all) {
      const list = sites.get(site.templateId);
      if (list === undefined) sites.set(site.templateId, [site]);
      else list.push(site);
    }
    return { templates, sites };
  }

  #facet(values: readonly string[]): { value: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
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

/** @module app/templates/template-edit — operator edits of a template (spec 13 §3.2 "Policy edit while sessions are live", §11.1 T1b): `PATCH`, disable and enable, sites, and the access tester. Edits that revoke access or disable the template close the affected live sessions (`closed_reason: 'operator'`); re-sealing and site changes reach the others at once (D16); a channel, proxy or headless change restarts the browser. */

import { normalizeHarness, UNKNOWN_HARNESS } from '@browserhive/contracts/harness';
import type {
  ResolveTemplateAccessRequest,
  ResolveTemplateAccessResponse,
  TemplateChangeResponse,
  TemplatePatchInput,
  TemplateSiteView,
} from '@browserhive/contracts/http';
import type { Session } from '../../domain/session/session.ts';
import {
  isSessionSealed,
  sealingFor,
  templateAccessRule,
  templateGate,
} from '../../domain/templates/model.ts';
import { validateTemplatePatch } from '../../domain/templates/patch.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import {
  type Repositories,
  type TemplateRecord,
  type TemplateSiteRecord,
  UNKNOWN_SITE_HEALTH,
  type UnitOfWork,
} from '../../ports/persistence/index.ts';
import type { JsonObject } from '../../ports/persistence/json.ts';
import type { TemplateHostOps, TemplateRuntime } from '../../ports/template-runtime.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { launchDeclaredHarnessOf, launchHarnessOf } from '../sessions/metadata.ts';
import type { SessionService } from '../sessions/session-service.ts';
import { notFoundForOperator, operationRunning, validationFailed } from './template-errors.ts';
import { toSiteView, toTemplateView } from './views.ts';

/** At most this many sites per template (spec 13 §2.1). */
const MAX_SITES = 16;

/** Collaborators of {@link TemplateEditService}. */
export interface TemplateEditDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites' | 'operatorActions'>;
  readonly uow: UnitOfWork;
  readonly runtime: TemplateRuntime;
  readonly ops: Pick<TemplateHostOps, 'restartHost' | 'held'>;
  readonly sessions: Pick<SessionService, 'peek' | 'close'>;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bus?: EventPublisher<DomainEvents>;
  /** The template's summary changed (`template.changed`). */
  readonly changed: (templateId: string) => void;
}

/** `CONFLICT` with an operator-facing message. */
function conflict(message: string): AppError<'CONFLICT'> {
  return new AppError('CONFLICT', {}, { publicMessage: message });
}

/** Operator edits of templates. */
export class TemplateEditService {
  readonly #deps: TemplateEditDeps;
  readonly #log: Logger;

  constructor(deps: TemplateEditDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.edit' });
  }

  /**
   * `PATCH /templates/{id}`.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT` (stale `If-Match`),
   *   `TEMPLATE_NAME_TAKEN`.
   */
  async update(
    templateId: string,
    input: TemplatePatchInput,
    options: { readonly ifMatch?: number | undefined; readonly by: string },
  ): Promise<TemplateChangeResponse> {
    const current = await this.#load(templateId);
    if (options.ifMatch !== undefined && options.ifMatch !== current.template.version) {
      throw new AppError('CONFLICT', { current_version: current.template.version });
    }
    const validated = validateTemplatePatch(input, current.template, this.#deps.clock.now());
    if (!validated.ok) throw validationFailed(validated.issues);
    const { patch, changed, restart } = validated.value;
    if (restart && this.#deps.ops.held(templateId)) throw operationRunning(templateId);
    if (changed.length === 0) {
      return { template: toTemplateView(current.template, current.sites), closed_sessions: [] };
    }
    const updated = await this.#deps.uow.transaction(async (repos) => {
      const row = await repos.templates.update(templateId, patch, options.ifMatch);
      await this.#audit(repos, options.by, 'template.update', templateId, {
        changed: [...changed],
      });
      return row;
    });
    const closed = await this.#reach(updated, current.sites);
    if (restart && this.#deps.runtime.host(templateId).state === 'running') {
      await this.#deps.ops
        .restartHost(updated)
        .catch((err: unknown) =>
          this.#log.warn('host not restarted', { err: serializeError(err) }),
        );
    }
    this.#log.info('template updated', { templateId, changed, closedSessions: closed.length });
    this.#deps.changed(templateId);
    return { template: toTemplateView(updated, current.sites), closed_sessions: closed };
  }

  /**
   * `POST /templates/{id}/disable|enable`. Disabling closes every live session; enabling returns
   * the template to `ready` (or `recording` when it has no version and no site was ever checked).
   */
  async setEnabled(
    templateId: string,
    enabled: boolean,
    by: string,
  ): Promise<TemplateChangeResponse> {
    const { template, sites } = await this.#load(templateId);
    if (!enabled && this.#deps.ops.held(templateId)) throw operationRunning(templateId);
    const now = this.#deps.clock.now();
    const target = enabled
      ? template.status === 'disabled'
        ? template.currentVersion === null && sites.every((site) => site.health.state === 'unknown')
          ? 'recording'
          : 'ready'
        : template.status
      : 'disabled';
    const updated =
      target === template.status
        ? template
        : await this.#deps.uow.transaction(async (repos) => {
            const row = await repos.templates.update(templateId, {
              status: target,
              disabledAt: enabled ? null : now,
              updatedAt: now,
            });
            await this.#audit(
              repos,
              by,
              enabled ? 'template.enable' : 'template.disable',
              templateId,
              {},
            );
            return row;
          });
    const closed = enabled ? [] : await this.#close(this.#live(templateId), 'disabled');
    this.#deps.changed(templateId);
    return { template: toTemplateView(updated, sites), closed_sessions: closed };
  }

  /**
   * `PUT /templates/{id}/sites/{site_id}`: adds the site (at most 16) or changes it.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND`, `VALIDATION_FAILED`.
   */
  async putSite(
    templateId: string,
    raw: string,
    body: {
      readonly enabled?: boolean | undefined;
      readonly write_policy?: TemplateSiteRecord['writePolicy'] | undefined;
    },
    by: string,
  ): Promise<TemplateSiteView> {
    const { template, sites } = await this.#load(templateId);
    const siteId = registrableDomain(raw);
    if (siteId === '') {
      throw validationFailed([
        {
          path: 'site_id',
          message: `'${raw}' is not a site: give a domain name like linkedin.com`,
          code: 'not_registrable',
        },
      ]);
    }
    const existing = sites.find((s) => s.siteId === siteId);
    if (existing === undefined && sites.length >= MAX_SITES) {
      throw validationFailed([
        {
          path: 'site_id',
          message: `a template has at most ${MAX_SITES} sites`,
          code: 'too_many_sites',
        },
      ]);
    }
    const now = this.#deps.clock.now();
    const site: TemplateSiteRecord =
      existing === undefined
        ? {
            templateId,
            siteId,
            packId: null,
            packVersion: null,
            enabled: body.enabled ?? true,
            writePolicy: body.write_policy ?? null,
            vaultHandle: null,
            autoRelogin: false,
            form: null,
            learnedCookieNames: [],
            health: UNKNOWN_SITE_HEALTH,
            stoppedAt: null,
            deviceBound: false,
            addedAt: now,
          }
        : {
            ...existing,
            ...(body.enabled !== undefined && { enabled: body.enabled }),
            ...(body.write_policy !== undefined && { writePolicy: body.write_policy }),
          };
    await this.#deps.uow.transaction(async (repos) => {
      await repos.templateSites.upsert(site);
      await this.#audit(repos, by, 'template.update', templateId, {
        changed: [`sites.${siteId}`],
        site: { site_id: siteId, enabled: site.enabled, write_policy: site.writePolicy },
      });
    });
    const after = await this.#deps.repos.templateSites.list(templateId);
    await this.#reach(template, after);
    const view = toSiteView(site);
    this.#deps.bus?.publish('template.health', {
      type: 'template.health',
      template_id: templateId,
      site: view,
    });
    this.#deps.changed(templateId);
    return view;
  }

  /**
   * `DELETE /templates/{id}/sites/{site_id}`: the site's sign-in stays in the jar.
   *
   * @throws AppError `TEMPLATE_NOT_FOUND` (template or site), `CONFLICT` (the last site).
   */
  async removeSite(templateId: string, raw: string, by: string): Promise<void> {
    const { template, sites } = await this.#load(templateId);
    const siteId = registrableDomain(raw) || raw;
    if (!sites.some((s) => s.siteId === siteId)) throw notFoundForOperator(templateId);
    if (sites.length === 1)
      throw conflict('A template needs at least one site; this is the last one.');
    await this.#deps.uow.transaction(async (repos) => {
      await repos.templateSites.remove(templateId, siteId);
      await this.#audit(repos, by, 'template.update', templateId, {
        changed: [`sites.${siteId}`],
        removed: true,
      });
    });
    await this.#reach(
      template,
      sites.filter((s) => s.siteId !== siteId),
    );
    this.#deps.changed(templateId);
  }

  /** `POST /templates/{id}/access/resolve`: the D-48 tester on the template's rule (operators only). */
  async resolveAccess(
    templateId: string,
    request: ResolveTemplateAccessRequest,
  ): Promise<ResolveTemplateAccessResponse> {
    const { template } = await this.#load(templateId);
    const rule = templateAccessRule(template);
    const unchecked = request.harness === undefined && request.harness_declared === undefined;
    const ruleView = {
      authorized_principals: [...rule.principals],
      ...(rule.harnesses !== null && { harnesses: [...rule.harnesses] }),
    };
    const gate = templateGate(unchecked ? { ...template, harnesses: null } : template, {
      // Without a principal only the harness part is tested.
      principal: request.principal ?? rule.principals[0] ?? 'local',
      harness:
        request.harness ??
        (request.harness_declared === undefined
          ? null
          : (normalizeHarness(request.harness_declared) ?? UNKNOWN_HARNESS)),
      declared: request.harness_declared ?? null,
    });
    return gate.allowed
      ? { allowed: true, rule: ruleView, harness_list_unchecked: unchecked }
      : { allowed: false, reason: gate.reason, rule: ruleView, harness_list_unchecked: unchecked };
  }

  // --- internals ----------------------------------------------------------------------------------

  async #load(
    templateId: string,
  ): Promise<{ template: TemplateRecord; sites: readonly TemplateSiteRecord[] }> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    return { template, sites: await this.#deps.repos.templateSites.list(templateId) };
  }

  #live(templateId: string): Session[] {
    return this.#deps.runtime.liveSessions(templateId).flatMap((id) => {
      const session = this.#deps.sessions.peek(id);
      return session === undefined ? [] : [session];
    });
  }

  /**
   * Applies an edit to the live sessions (spec 13 §3.2): a session whose principal or harness lost
   * access closes with `operator`; every other one gets the new sealing and sites at once (D16).
   */
  async #reach(template: TemplateRecord, sites: readonly TemplateSiteRecord[]): Promise<string[]> {
    const lost: Session[] = [];
    for (const session of this.#live(template.templateId)) {
      const client = session.request.client ?? null;
      const gate = templateGate(template, {
        principal: session.owner,
        harness: launchHarnessOf(client),
        declared: launchDeclaredHarnessOf(client),
      });
      if (!gate.allowed) {
        lost.push(session);
        continue;
      }
      const sealing = sealingFor(template.unseal, session.owner);
      session.retemplate({
        sealing,
        sealed: isSessionSealed(sealing),
        sites: sites
          .filter((s) => s.enabled)
          .map((s) => ({ site: s.siteId, status: s.health.state })),
      });
    }
    return await this.#close(lost, 'access');
  }

  async #close(sessions: readonly Session[], why: string): Promise<string[]> {
    const ids = sessions.map((s) => s.id);
    await Promise.allSettled(ids.map((id) => this.#deps.sessions.close(id, 'operator')));
    if (ids.length > 0) this.#log.info('template sessions closed', { why, sessions: ids });
    return ids;
  }

  async #audit(
    repos: Pick<Repositories, 'operatorActions'>,
    by: string,
    action: string,
    templateId: string,
    details: JsonObject,
  ): Promise<void> {
    await repos.operatorActions.append({
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

/** @module app/templates/health-facade — the operator's health and re-login operations behind the T2 routes (spec 13 §11.1): **Check now**, the probe history, re-login, **Show window**, **Let agents continue** and the vault link, each audited (§11.8). */

import type {
  ContinueAgentsResponse,
  ProbeTemplateResponse,
  PutReloginLinkResponse,
  ReloginResponse,
  ShowTemplateWindowResponse,
  TemplateProbesPage,
  TemplateProbesQuery,
} from '@browserhive/contracts/http';
import type { SessionPrincipal } from '../../domain/session/principal.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Repositories } from '../../ports/persistence/index.ts';
import type { ReloginLinkInput, ReloginLinks } from './relogin-link.ts';
import { disabled, notFoundForOperator } from './template-errors.ts';
import type { TemplateHealthService } from './template-health.ts';
import type { TemplateReloginService } from './template-relogin.ts';

/** How long **Check now** waits for its probes (spec 13 §11.1). */
export const PROBE_ROUTE_WAIT_MS = 120_000;

/** Collaborators of {@link TemplateHealthFacade}. */
export interface HealthFacadeDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateProbes' | 'operatorActions'>;
  readonly health: Pick<TemplateHealthService, 'probe'>;
  readonly relogin: TemplateReloginService;
  readonly links: ReloginLinks;
  readonly ids: Pick<IdGenerator, 'eventId'>;
  readonly clock: Clock;
}

/** The T2 operator operations. */
export class TemplateHealthFacade {
  readonly #deps: HealthFacadeDeps;

  constructor(deps: HealthFacadeDeps) {
    this.#deps = deps;
  }

  /** `POST …/probe` (**Check now**): starts a stopped browser, waits at most 120 s. */
  async probe(
    templateId: string,
    siteIds: readonly string[] | undefined,
    by: string,
  ): Promise<ProbeTemplateResponse> {
    const template = await this.#deps.repos.templates.get(templateId);
    if (template === null) throw notFoundForOperator(templateId);
    if (template.status === 'disabled') throw disabled(template.name);
    const controller = new AbortController();
    const timer = this.#deps.clock
      .sleep(PROBE_ROUTE_WAIT_MS, controller.signal)
      .then(() => controller.abort())
      .catch(() => undefined);
    try {
      const run = await this.#deps.health.probe(templateId, {
        trigger: 'manual',
        start: 'always',
        signal: controller.signal,
        ...(siteIds !== undefined && { siteIds }),
      });
      await this.#audit(by, 'template.probe', templateId, { site_ids: siteIds ?? null });
      return {
        results: (run ?? []).map((r) => ({
          site_id: r.siteId,
          outcome: r.outcome,
          reason: r.reason,
          duration_ms: r.durationMs,
        })),
      };
    } finally {
      controller.abort();
      await timer;
    }
  }

  /** `GET …/probes`. */
  async probes(templateId: string, query: TemplateProbesQuery): Promise<TemplateProbesPage> {
    if ((await this.#deps.repos.templates.get(templateId)) === null) {
      throw notFoundForOperator(templateId);
    }
    const page = await this.#deps.repos.templateProbes.list(templateId, {
      limit: query.limit,
      ...(query.cursor !== undefined && { cursor: query.cursor }),
      ...(query.site_id !== undefined && { siteId: query.site_id }),
      ...(query.outcome !== undefined && { outcomes: query.outcome }),
      ...(query.trigger !== undefined && { triggers: query.trigger }),
      ...(query.since !== undefined && { since: query.since }),
      ...(query.until !== undefined && { until: query.until }),
    });
    return {
      data: page.items.map((p) => ({
        seq: p.seq,
        site_id: p.siteId,
        outcome: p.outcome,
        reason: p.reason,
        trigger: p.trigger,
        final_url: p.finalUrl,
        duration_ms: p.durationMs,
        at: p.at,
      })),
      page: { next_cursor: page.nextCursor, limit: query.limit },
      applied: {
        filters: {
          ...(query.site_id !== undefined && { site_id: query.site_id }),
          ...(query.outcome !== undefined && { outcome: query.outcome }),
          ...(query.trigger !== undefined && { trigger: query.trigger }),
        },
        sort: { key: 'at', dir: 'desc' },
      },
      meta: { now: this.#deps.clock.now() },
    };
  }

  /** `POST …/relogin`. */
  startRelogin(
    templateId: string,
    request: {
      readonly siteId: string;
      readonly method: 'window' | 'vault';
      readonly letAgentsContinue: boolean;
    },
    principal: SessionPrincipal,
  ): Promise<ReloginResponse> {
    return this.#deps.relogin.start(templateId, request, principal);
  }

  /** `POST …/relogin/confirm`. */
  confirmRelogin(
    templateId: string,
    siteId: string,
    by: string,
    requestedAt?: number,
  ): Promise<ReloginResponse> {
    return this.#deps.relogin.confirm(templateId, siteId, by, requestedAt);
  }

  /** `DELETE …/relogin`. */
  cancelRelogin(templateId: string, by: string, requestedAt?: number): Promise<ReloginResponse> {
    return this.#deps.relogin.cancel(templateId, by, requestedAt);
  }

  /** `POST …/host/show`. */
  async show(templateId: string, principal: SessionPrincipal): Promise<ShowTemplateWindowResponse> {
    if ((await this.#deps.repos.templates.get(templateId)) === null) {
      throw notFoundForOperator(templateId);
    }
    const shown = await this.#deps.relogin.show(templateId, principal);
    return { ok: true, window: shown.window, session_id: shown.sessionId };
  }

  /** `POST …/agents/continue` (D-60). */
  async continueAgents(templateId: string, by: string): Promise<ContinueAgentsResponse> {
    if ((await this.#deps.repos.templates.get(templateId)) === null) {
      throw notFoundForOperator(templateId);
    }
    this.#deps.relogin.continueAgents(templateId);
    await this.#audit(by, 'template.agents.continue', templateId, {});
    return { ok: true, agents_paused: false };
  }

  /** `PUT …/sites/{site_id}/relogin`. */
  putLink(
    templateId: string,
    siteId: string,
    input: ReloginLinkInput,
    by: string,
  ): Promise<PutReloginLinkResponse> {
    return this.#deps.links.put(templateId, siteId, input, by);
  }

  async #audit(
    by: string,
    action: string,
    templateId: string,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.#deps.repos.operatorActions.append({
      eventId: this.#deps.ids.eventId(),
      principalId: by,
      action,
      resourceKind: 'template',
      resourceId: templateId,
      details: JSON.parse(JSON.stringify(details)),
      occurredAt: this.#deps.clock.now(),
    });
  }
}

/** The T2 operations under `templates=false`: every template is unknown. */
export function unavailableHealthFacade(): Pick<
  TemplateHealthFacade,
  | 'probe'
  | 'probes'
  | 'startRelogin'
  | 'confirmRelogin'
  | 'cancelRelogin'
  | 'show'
  | 'continueAgents'
  | 'putLink'
> {
  const none = async (templateId: string): Promise<never> => {
    throw notFoundForOperator(templateId);
  };
  return {
    probe: none,
    probes: none,
    startRelogin: none,
    confirmRelogin: none,
    cancelRelogin: none,
    show: none,
    continueAgents: none,
    putLink: none,
  };
}

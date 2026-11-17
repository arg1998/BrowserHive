/** @module app/templates/template-detail — `GET /templates/{template_id}` (spec 13 §11.1): the template, its browser, sites, parked pages, shared windows, unlisted sign-ins, the current re-login and the machine. */

import type { ReloginView, TemplateDetailResponse } from '@browserhive/contracts/http';
import { unlistedDomains } from '../../domain/templates/sign-ins.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Repositories, TemplateVersionRepository } from '../../ports/persistence/index.ts';
import type { TemplateHostOps, TemplateRuntime } from '../../ports/template-runtime.ts';
import { notFoundForOperator } from './template-errors.ts';
import type { TemplatePacks } from './template-packs.ts';
import { storedUnlisted } from './template-reads.ts';
import { toTemplateDetail } from './views.ts';

/** What the detail is read from. */
export interface TemplateDetailDeps {
  readonly repos: Pick<Repositories, 'templates' | 'templateSites'>;
  readonly runtime: Pick<TemplateRuntime, 'host' | 'liveSessions'>;
  readonly ops?: Pick<TemplateHostOps, 'jar' | 'sharedWindows'>;
  readonly versions?: Pick<TemplateVersionRepository, 'list'>;
  readonly clock: Clock;
  /** The packs in force for the sites' views (T3a). */
  readonly packs?: TemplatePacks;
}

/** The T2 parts of the detail. */
export interface TemplateDetailExtras {
  readonly reloginOf?: (templateId: string) => ReloginView | null;
  readonly machine?: string;
}

/**
 * Reads one template's detail.
 *
 * @throws AppError `TEMPLATE_NOT_FOUND`.
 */
export async function readTemplateDetail(
  deps: TemplateDetailDeps,
  extras: TemplateDetailExtras,
  templateId: string,
): Promise<TemplateDetailResponse> {
  const template = await deps.repos.templates.get(templateId);
  if (template === null) throw notFoundForOperator(templateId);
  const sites = await deps.repos.templateSites.list(templateId);
  const host = deps.runtime.host(templateId);
  const jar = (await deps.ops?.jar(templateId)) ?? null;
  const shared = (await deps.ops?.sharedWindows(templateId)) ?? [];
  const own = sites.map((s) => s.siteId);
  const unlisted =
    jar === null
      ? await storedUnlisted(deps.versions, templateId, new Set(own))
      : unlistedDomains(jar, own);
  return toTemplateDetail(
    template,
    sites,
    { ...host, sharedWindows: shared },
    deps.runtime.liveSessions(templateId).length,
    deps.clock.now(),
    {
      unlistedDomains: unlisted,
      relogin: extras.reloginOf?.(templateId) ?? null,
      machine: extras.machine ?? '',
    },
    deps.packs,
  );
}

/** Collaborators the template service gets after composition (spec 13 §8, PR T2). */
export interface TemplateServiceHooks extends TemplateDetailExtras {
  /** Closes a session a racing edit left without access (deferred D24). */
  readonly closeSession?: (sessionId: string) => Promise<unknown>;
}

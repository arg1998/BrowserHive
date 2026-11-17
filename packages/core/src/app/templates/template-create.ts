/** @module app/templates/template-create — `POST /templates` (spec 13 §2, §9.6, §11.1): validation, the pinned identity, the pack-dependent refusals, and the template, its sites and their first-use pack approvals written in one transaction (review #83 C-L9). */

import type { Template, TemplateInput } from '@browserhive/contracts/http';
import {
  buildTemplate,
  pinnedIdentity,
  type TemplateDefaults,
  validateTemplateInput,
} from '../../domain/templates/create.ts';
import type { Clock } from '../../ports/clock.ts';
import type { TemplateGeoResolver } from '../../ports/geo-seed-resolver.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Repositories, UnitOfWork } from '../../ports/persistence/index.ts';
import { nameTaken, validationFailed } from './template-errors.ts';
import {
  NO_PACKS,
  packRequirementIssues,
  prepareSiteApprovals,
  reviewedHashes,
  type TemplatePacks,
} from './template-packs.ts';
import { toTemplateView } from './views.ts';

/** What the creation needs (a slice of the template service's dependencies). */
export interface TemplateCreateDeps {
  readonly repos: Pick<Repositories, 'templates'>;
  readonly uow: UnitOfWork;
  readonly geo: TemplateGeoResolver;
  readonly ids: Pick<IdGenerator, 'opaque' | 'eventId'>;
  readonly clock: Clock;
  readonly config: {
    readonly authMode: 'off' | 'token';
    readonly defaults: TemplateDefaults;
  };
  readonly packs?: TemplatePacks;
}

/** Characters of the seed that feeds the template's fingerprint for its life (spec 13 §2.2). */
const SEED_LENGTH = 21;
/** Characters after `tp-` (D-05). */
const TEMPLATE_ID_LENGTH = 10;

/**
 * Creates a template in `recording`.
 *
 * @throws AppError `VALIDATION_FAILED`, `TEMPLATE_NAME_TAKEN`, `SITE_PACK_APPROVAL_REQUIRED`,
 *   `CONFLICT`, `SITE_PACK_DOMAIN_TAKEN`.
 */
export async function createTemplate(
  deps: TemplateCreateDeps,
  input: TemplateInput,
  owner: string,
): Promise<Template> {
  const { config, ids, clock, geo } = deps;
  const validated = validateTemplateInput(input, { authMode: config.authMode });
  if (!validated.ok) throw validationFailed(validated.issues);
  if ((await deps.repos.templates.getByName(input.name)) !== null) throw nameTaken(input.name);
  const resolved = await geo.resolve({
    ...(input.locale !== undefined && { locale: input.locale }),
    ...(input.timezone_id !== undefined && { timezoneId: input.timezone_id }),
  });
  const identity = pinnedIdentity(ids.opaque(SEED_LENGTH), resolved, input.geolocation);
  const now = clock.now();
  const built = buildTemplate(input, validated.value, {
    templateId: `tp-${ids.opaque(TEMPLATE_ID_LENGTH)}`,
    owner,
    now,
    identity,
    defaults: config.defaults,
    authMode: config.authMode,
  });
  const { template } = built;
  const packs = deps.packs ?? NO_PACKS;
  const siteIds = built.sites.map((s) => s.siteId);
  const packIssues = packRequirementIssues(packs, siteIds, template);
  if (packIssues.length > 0) throw validationFailed(packIssues);
  const { sites, approvals } = await prepareSiteApprovals(
    packs,
    built.sites,
    reviewedHashes(input.sites),
    owner,
  );
  await deps.uow.transaction(async (repos) => {
    await repos.templates.insert(template);
    for (const site of sites) await repos.templateSites.upsert(site);
    for (const approval of approvals) await approval.write(repos);
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
  if (approvals.some((a) => a.approves)) await packs.approvalsCommitted();
  return toTemplateView(template, sites, packs);
}

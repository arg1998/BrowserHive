/** @module infra/site-packs/template-guard — the request guard every template host carries as its chain's handler 3 (spec 13 §3.8, §9.3): the host's pack rule source, the guard-hit writer bound to its template, the security intercepts' confirmer (`null` under `transport=stdio`) and the write pacer (`pace-writes`, §9.4). */

import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { RequestConfirmer } from '../../ports/request-guard.ts';
import type { WritePolicyOverrides } from '../../ports/site-guards.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { WritePacing } from '../../ports/write-pacing.ts';
import { requestGuardHandler } from '../browsers/request-guard-route.ts';
import type { TemplateRequestGuard } from '../browsers/template-launch.ts';
import type { SiteGuardHitsWriter } from './guard-hits-writer.ts';
import { type GuardRuleCatalog, PackGuardRuleSource } from './guard-rules.ts';

/** No pack applies anywhere (`DEFAULT_GUARDS` still do): the lookup until the registry exists. */
export const NO_SITE_PACKS: SitePackLookup = Object.freeze({
  effectiveFor: () => null,
  effectiveById: () => null,
  generation: 0,
});

/** Collaborators of {@link templateRequestGuard}. */
export interface TemplateRequestGuardDeps {
  readonly lookup: SitePackLookup;
  /** Loaded before the host's first request, so its overrides apply from the start. */
  readonly overrides: WritePolicyOverrides & { load(templateId: string): Promise<void> };
  readonly catalog: GuardRuleCatalog;
  readonly hits: SiteGuardHitsWriter;
  readonly confirmer: RequestConfirmer | null;
  /** `pace-writes` (spec 13 §9.4); absent = no pacing. */
  readonly pacer?: WritePacing | null;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Query keys kept in audited URLs (`urlQueryAllowlist`, D-20). */
  readonly urlQueryAllowlist?: readonly string[];
}

/** The factory the driver calls at every template host start. */
export function templateRequestGuard(deps: TemplateRequestGuardDeps): TemplateRequestGuard {
  return async (templateId) => {
    await deps.overrides.load(templateId);
    return requestGuardHandler({
      rules: new PackGuardRuleSource({
        templateId,
        lookup: deps.lookup,
        overrides: deps.overrides,
        catalog: deps.catalog,
        logger: deps.logger,
      }),
      hits: deps.hits.forTemplate(templateId),
      confirmer: deps.confirmer,
      pace: paceOf(deps.pacer ?? null, templateId),
      clock: deps.clock,
      logger: deps.logger,
      ...(deps.urlQueryAllowlist !== undefined && { urlQueryAllowlist: deps.urlQueryAllowlist }),
    });
  };
}

/** The host's pace question, bound to its template. */
function paceOf(pacer: WritePacing | null, templateId: string) {
  return pacer === null ? null : (ruleId: string) => pacer.pace({ templateId, ruleId });
}

/** @module infra/site-packs/document-guard — the `GET` document guard of `navigate`/`new_tab` on the tool path (spec 13 §9.3): the very rules the template host's request guard applies (`PackGuardRuleSource`: the owning pack's guards with the write policy resolved, then `DEFAULT_GUARDS`), matched as a `GET` `document`, so both paths always agree. */

import { matchRequestGuard } from '../../domain/policies/request-guard.ts';
import type { Logger } from '../../ports/logger.ts';
import type { WritePolicyOverrides } from '../../ports/site-guards.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { DocumentGuardResolver } from '../../ports/site-tool-guards.ts';
import { type GuardRuleCatalog, PackGuardRuleSource } from './guard-rules.ts';

/** Collaborators of {@link documentGuardResolver}. */
export interface DocumentGuardDeps {
  readonly lookup: SitePackLookup;
  readonly overrides: WritePolicyOverrides;
  readonly catalog: GuardRuleCatalog;
  readonly logger: Logger;
}

/** Templates whose rule sources are kept (a source is cheap; its compiled sets are cached in it). */
const MAX_SOURCES = 256;

/** `(templateId, url) → the guard a GET document load of url hits`, or `null`. Never throws. */
export function documentGuardResolver(deps: DocumentGuardDeps): DocumentGuardResolver {
  const sources = new Map<string, PackGuardRuleSource>();
  return (templateId, url) => {
    let source = sources.get(templateId);
    if (source === undefined) {
      if (sources.size >= MAX_SOURCES) sources.clear();
      source = new PackGuardRuleSource({ templateId, ...deps });
      sources.set(templateId, source);
    }
    const hit = matchRequestGuard(source.rulesFor(url), {
      url,
      method: 'GET',
      resourceType: 'document',
    });
    if (hit === null) return null;
    const info = deps.catalog.describe(hit.rule.id);
    if (info === null) return null;
    return {
      ruleId: hit.rule.id,
      packId: info.packId,
      guardId: info.guardId,
      kind: info.guardKind,
      action: hit.rule.action,
    };
  };
}

/** @module app/site-packs/registry-floor — D-71 where no operator action can be refused (review #84 M1): when the content in force changes without an Apply (an approved local file deleted or back, a revocation's fallback, a stored approval readable again), each template whose enabled site falls below the new content's `stealth-profile` floor gets that site turned off (`enabled=false` and an audit row by `browserhive`), and the operator a `TEMPLATE_SITE_BELOW_FLOOR` degradation naming the templates and why. It resolves once no turned-off site is below its pack's floor (the site or template removed, or a version with a lower floor). */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { packFloorIssues, type StealthFloorIssue } from '../../domain/site-packs/stealth-floor.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { RegistryCore } from './registry-core.ts';
import type { PackEntry } from './registry-types.ts';

/** The degradation of a site turned off below its pack's floor. */
export const SITE_BELOW_FLOOR = 'TEMPLATE_SITE_BELOW_FLOOR';

/** The principal of automatic decisions (spec 13 §11.8). */
const SYSTEM = 'browserhive';

/** Why the content in force changed without an Apply. */
export type FloorReason = 'local_override_ended' | 'content_changed';

/** One template below the floor, with the sites of the pack turned off on it. */
interface BelowFloor {
  readonly template_id: string;
  readonly name: string;
  readonly site_ids: string[];
  readonly issues: readonly StealthFloorIssue[];
  readonly sites: TemplateSiteRecord[];
}

/**
 * Turns off every enabled template site whose template is below the floor of its pack's content in
 * force, and reports it; resolves the degradation when no turned-off site is below a floor. Every
 * operator path (template creation, site add and enable, Apply, Revert, approve-local) refuses a
 * below-floor state first, so anything found here came from a change no operator approved.
 * Returns the templates whose sites were turned off. Never throws: a failure is logged.
 */
export async function enforceFloor(core: RegistryCore): Promise<string[]> {
  try {
    return await enforce(core);
  } catch (err) {
    core.log.warn('floor check failed', { err: serializeError(err) });
    return [];
  }
}

async function enforce(core: RegistryCore): Promise<string[]> {
  const { repos } = core.deps;
  const snapshot = core.snapshot();
  const [sites, templates] = await Promise.all([
    repos.templateSites.listAll(),
    repos.templates.listAll(),
  ]);
  const byId = new Map(templates.map((t) => [t.templateId, t]));
  const below = new Map<string, Map<string, BelowFloor>>();
  let offBelow = false;
  for (const site of sites) {
    if (site.packId === null) continue;
    const effective = snapshot.packs.get(site.packId)?.effective ?? null;
    const template = byId.get(site.templateId);
    if (effective === null || template === undefined) continue;
    const issues = packFloorIssues(template, effective.pack);
    if (issues.length === 0) continue;
    if (!site.enabled) {
      offBelow = true;
      continue;
    }
    const perPack = below.get(site.packId) ?? new Map<string, BelowFloor>();
    const entry = perPack.get(template.templateId) ?? {
      template_id: template.templateId,
      name: template.name,
      site_ids: [],
      issues,
      sites: [],
    };
    entry.site_ids.push(site.siteId);
    entry.sites.push(site);
    perPack.set(template.templateId, entry);
    below.set(site.packId, perPack);
  }
  const touched = new Set<string>();
  for (const [packId, perPack] of below) {
    const entry = snapshot.packs.get(packId);
    if (entry === undefined) continue;
    const list = [...perPack.values()];
    await turnOff(core, entry, list);
    for (const t of list) touched.add(t.template_id);
  }
  if (!offBelow && below.size === 0) core.deps.degradations?.recovered(SITE_BELOW_FLOOR);
  return [...touched];
}

async function turnOff(
  core: RegistryCore,
  entry: PackEntry,
  list: readonly BelowFloor[],
): Promise<void> {
  const { deps } = core;
  const effective = entry.effective;
  if (effective === null) return;
  const reason: FloorReason =
    entry.state?.localApprovedSha256 != null && !effective.localOverride
      ? 'local_override_ended'
      : 'content_changed';
  const now = deps.clock.now();
  await deps.uow.transaction(async (repos) => {
    for (const t of list) {
      for (const site of t.sites) {
        await repos.templateSites.upsert({ ...site, enabled: false });
        await repos.operatorActions.append({
          eventId: deps.ids.eventId(),
          principalId: SYSTEM,
          action: 'template.update',
          resourceKind: 'template',
          resourceId: t.template_id,
          details: {
            changed: [`sites.${site.siteId}`],
            site: { site_id: site.siteId, enabled: false, pack_id: entry.packId },
            reason: 'below_pack_floor',
            pack_version: effective.version,
            why: reason,
            issues: t.issues.map((i) => i.code),
          },
          occurredAt: now,
        });
      }
    }
  });
  const details = {
    pack_id: entry.packId,
    version: effective.version,
    reason,
    template_ids: list.map((t) => t.template_id),
    templates: list.map((t) => ({
      template_id: t.template_id,
      name: t.name,
      site_ids: [...t.site_ids],
      issues: t.issues.map((i) => ({ code: i.code, message: i.message })),
    })),
    templates_text: list
      .map((t) => `'${t.name}' ${t.issues.map((i) => i.message).join(' and ')}`)
      .join('; '),
  };
  core.log.warn('site off below floor', {
    packId: entry.packId,
    version: effective.version,
    reason,
    templateIds: details.template_ids,
  });
  deps.degradations?.report({
    code: SITE_BELOW_FLOOR,
    severity: 'error',
    message: renderMessage(ERROR_REGISTRY.TEMPLATE_SITE_BELOW_FLOOR.message, details),
    details,
  });
}

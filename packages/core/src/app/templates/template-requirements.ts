/** @module app/templates/template-requirements — the pack requirements beyond creation (spec 13 §9.4 `stealth-profile`, §9.6 hook table "Template creation, site add", §11.1): adding or enabling a site whose pack the template does not meet, and a template edit that falls below an enabled site's pack (lowering stealth, changing fingerprint noise, going headless), answer `VALIDATION_FAILED` with the issue codes of `packRequirementIssues`. */

import type { TemplateRecord, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import { validationFailed } from './template-errors.ts';
import {
  type PackRequirementIssue,
  type PackRequirementSettings,
  packRequirementIssues,
  type TemplatePacks,
} from './template-packs.ts';

/** The template field an issue asks the operator to change (`PATCH` paths). */
const FIELD_OF: Readonly<Record<PackRequirementIssue['code'], string>> = {
  headed_required: 'headless',
  human_only_stealth_off: 'stealth',
  stealth_below_floor: 'stealth',
  fingerprint_required: 'fingerprint',
  fingerprint_forbidden: 'fingerprint',
};

/**
 * `PUT …/sites/{site_id}`: a site being added, enabled, or given a newly reviewed pack must have its
 * pack's requirements met (path `site_id`). Changing only the write policy of a site checks nothing.
 *
 * @throws AppError `VALIDATION_FAILED`.
 */
export function assertSiteMeetsPack(
  packs: TemplatePacks,
  siteId: string,
  template: TemplateRecord,
  existing: TemplateSiteRecord | undefined,
  body: { readonly enabled?: boolean | undefined; readonly pack_sha256?: string | undefined },
): void {
  const enabledAfter = body.enabled ?? existing?.enabled ?? true;
  const enabling = existing === undefined || !existing.enabled || body.pack_sha256 !== undefined;
  if (!enabledAfter || !enabling) return;
  const issues = packRequirementIssues(packs, [siteId], template);
  if (issues.length > 0) throw validationFailed(issues.map((i) => ({ ...i, path: 'site_id' })));
}

/**
 * `PATCH /templates/{id}`: the edit may not introduce a requirement issue on an enabled site (one
 * the template already had, from a pack applied earlier, does not block unrelated edits). The path
 * names the field to change (`stealth`, `fingerprint`, `headless`).
 *
 * @throws AppError `VALIDATION_FAILED`.
 */
export function assertEditMeetsPacks(
  packs: TemplatePacks,
  sites: readonly TemplateSiteRecord[],
  before: PackRequirementSettings,
  after: PackRequirementSettings,
): void {
  const enabled = sites.filter((s) => s.enabled).map((s) => s.siteId);
  if (enabled.length === 0) return;
  const key = (i: PackRequirementIssue) => `${i.path}\u0000${i.code}`;
  const had = new Set(packRequirementIssues(packs, enabled, before).map(key));
  const issues = packRequirementIssues(packs, enabled, after)
    .filter((i) => !had.has(key(i)))
    .map((i) => ({ ...i, path: FIELD_OF[i.code] }));
  if (issues.length > 0) throw validationFailed(issues);
}

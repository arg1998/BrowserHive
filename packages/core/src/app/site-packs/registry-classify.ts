/** @module app/site-packs/registry-classify — the registry's use of `classifyPackChange` (spec 13 §9.7): which templates use a pack (their stealth settings feed the `stealth-profile` restrictive rule), the classification of a candidate as a stored change row, and the stealth floor Apply checks (`SITE_PACK_BELOW_FLOOR`, T3b lead decision 4). */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import {
  type ClassifyContext,
  classifyPackChange,
  NO_TEMPLATES,
  type PackChangeClassification,
  type UsingTemplate,
} from '../../domain/site-packs/classify.ts';
import { packFloorIssues, type StealthFloorIssue } from '../../domain/site-packs/stealth-floor.ts';
import type { Repositories } from '../../ports/persistence/index.ts';
import type {
  SitePackChangeFieldRecord,
  SitePackChangeRecord,
  SitePackClassificationValue,
} from '../../ports/persistence/site-packs.ts';
import { withUsage } from './registry-build.ts';
import type { RegistrySnapshot } from './registry-types.ts';

/** The repositories the usage reads. */
export type UsageRepos = Pick<Repositories, 'templates' | 'templateSites'>;

/** Per pack id, the templates whose **enabled** sites use it (a disabled site is out of the floor's reach). */
export type PackUsage = (packId: string) => ClassifyContext;

/** Reads every template site and template once and answers per pack. */
export async function readPackUsage(repos: UsageRepos): Promise<PackUsage> {
  const [sites, templates] = await Promise.all([
    repos.templateSites.listAll(),
    repos.templates.listAll(),
  ]);
  const byId = new Map(templates.map((t) => [t.templateId, t]));
  const usage = new Map<string, UsingTemplate[]>();
  for (const site of sites) {
    if (site.packId === null || !site.enabled) continue;
    const template = byId.get(site.templateId);
    if (template === undefined) continue;
    const list = usage.get(site.packId) ?? [];
    if (list.some((t) => t.templateId === template.templateId)) continue;
    list.push({
      templateId: template.templateId,
      name: template.name,
      stealth: template.stealth,
      fingerprint: template.fingerprint,
    });
    usage.set(site.packId, list);
  }
  return (packId) => {
    const using = usage.get(packId);
    return using === undefined ? NO_TEMPLATES : { usingTemplates: using };
  };
}

/** The usage of one pack. */
export async function usageOf(repos: UsageRepos, packId: string): Promise<ClassifyContext> {
  return (await readPackUsage(repos))(packId);
}

/** A classification as `site_pack_changes` stores it. */
export interface StoredClassification {
  readonly classification: SitePackClassificationValue;
  readonly diff: readonly SitePackChangeFieldRecord[];
}

/** Classifies `to` against `from` for storage (`new_pack` without an approved version). */
export function classifyForRow(
  from: SitePackV1 | null,
  to: SitePackV1,
  ctx: ClassifyContext,
): StoredClassification {
  const result: PackChangeClassification = classifyPackChange(from, to, ctx);
  return { classification: result.classification, diff: result.changes.map((c) => ({ ...c })) };
}

/** True when two stored classifications differ (classification or any field's class). */
export function classificationChanged(
  stored: {
    readonly classification: string;
    readonly diff: readonly SitePackChangeFieldRecord[] | null;
  },
  next: StoredClassification,
): boolean {
  if (stored.classification !== next.classification) return true;
  if (stored.diff === null || stored.diff.length !== next.diff.length) return true;
  return stored.diff.some(
    (f, i) => f.path !== next.diff[i]?.path || f.class !== next.diff[i]?.class,
  );
}

/** The verified content of a downloaded registry or imported row (BrowserHive's copy), or `null`. */
export type SignedContent = (
  packId: string,
  row: SitePackChangeRecord,
) => Promise<SitePackV1 | null>;

/** One template below a candidate's `stealth-profile` floor. */
export interface FloorBlocker {
  readonly template_id: string;
  readonly name: string;
  readonly issues: readonly StealthFloorIssue[];
}

/** The using templates whose stealth settings are below `pack`'s floor (empty when none). */
export function floorBlockers(ctx: ClassifyContext, pack: SitePackV1): FloorBlocker[] {
  const out: FloorBlocker[] = [];
  for (const t of ctx.usingTemplates) {
    const issues = packFloorIssues(t, pack);
    if (issues.length > 0) out.push({ template_id: t.templateId, name: t.name, issues });
  }
  return out;
}

/**
 * Classifies every pending candidate of `snapshot` whose content this release holds against the
 * approved version with the templates' current settings, storing what changed (rows written before
 * the classifier, and rows whose `stealth-profile` verdict moved with a template edit). Rows marked
 * `revoked` keep the verdict of their revocation. Returns the snapshot with the stored rows and the
 * packs whose rows changed.
 */
export async function reclassifyPending(
  repo: Pick<Repositories['sitePackChanges'], 'classify'>,
  snapshot: RegistrySnapshot,
  usage: PackUsage,
  signed?: SignedContent,
): Promise<{ snapshot: RegistrySnapshot; changed: string[] }> {
  const contents = new Map(snapshot.bundled.packs.map((p) => [p.sha256, p.pack]));
  const contentOf = async (packId: string, row: SitePackChangeRecord) => {
    const bundled = contents.get(row.toSha256);
    if (bundled !== undefined) return bundled;
    const verified =
      row.decision === 'downloaded' && (row.source === 'remote' || row.source === 'import');
    return verified && signed !== undefined
      ? ((await signed(packId, row)) ?? undefined)
      : undefined;
  };
  const packs = new Map(snapshot.packs);
  const changed: string[] = [];
  for (const [packId, entry] of snapshot.packs) {
    if (entry.pending.length === 0) continue;
    let moved = false;
    const pending: SitePackChangeRecord[] = [];
    for (const row of entry.pending) {
      const to = row.classification === 'revoked' ? undefined : await contentOf(packId, row);
      if (row.classification === 'revoked' || to === undefined) {
        pending.push(row);
        continue;
      }
      const next = classifyForRow(entry.approved?.pack ?? null, to, usage(packId));
      if (!classificationChanged(row, next)) {
        pending.push(row);
        continue;
      }
      await repo.classify(row.eventId, next.classification, next.diff);
      pending.push({ ...row, classification: next.classification, diff: next.diff });
      moved = true;
    }
    if (!moved) continue;
    packs.set(packId, { ...entry, pending });
    changed.push(packId);
  }
  return { snapshot: changed.length === 0 ? snapshot : { ...snapshot, packs }, changed };
}

/**
 * The snapshot with `used_by` re-read from the template sites and its pending versions
 * re-classified with the templates' settings (after template or site changes); `changed` lists
 * the packs either moved.
 */
export async function withFreshUsage(
  repos: UsageRepos & Pick<Repositories, 'sitePackChanges'>,
  snapshot: RegistrySnapshot,
  signed?: SignedContent,
): Promise<{ snapshot: RegistrySnapshot; changed: string[] }> {
  const used = withUsage(snapshot, await repos.templateSites.listAll());
  const usage = await readPackUsage(repos);
  const re = await reclassifyPending(repos.sitePackChanges, used.snapshot, usage, signed);
  return { snapshot: re.snapshot, changed: [...new Set([...used.changed, ...re.changed])] };
}

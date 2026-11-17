/** @module app/templates/template-packs — what the template services need from the site-pack registry (spec 13 §9.6, T3a): approval on first use when a site is added, the pack in force for a site's view, its identity provider (notification threads) and `human_only` (no vault re-login). `NO_PACKS` is the answer when packs are off or not wired. */

import type { TemplateSitePack, TemplateStrategyNote } from '@browserhive/contracts/http';
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import {
  packFloorIssues,
  type StealthFloorIssue,
  type StealthSettings,
} from '../../domain/site-packs/stealth-floor.ts';
import {
  type StrategyNoteSettings,
  strategyNotesOf,
} from '../../domain/site-packs/strategy-notes.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import type { PreparedApproval } from '../site-packs/registry-types.ts';

/** The registry as the template services see it (`SitePackRegistry` fits). */
export interface TemplatePacks {
  /**
   * Prepares the first-use approval of a new site; `sha256` is the version the operator reviewed
   * (`SITE_PACK_APPROVAL_REQUIRED` without it when one is needed, `CONFLICT` on mismatch). Its
   * `write` runs in the site's transaction. `null` when no pack covers the site.
   */
  prepareSite(
    siteId: string,
    sha256: string | undefined,
    by: string,
  ): Promise<PreparedApproval | null>;
  /** After the approvals' transaction committed. */
  approvalsCommitted(): Promise<void>;
  /** The pack in force for a site's `pack_id`, or `null`. */
  sitePackOf(packId: string | null): TemplateSitePack | null;
  /** The pack's identity provider, or `null`. */
  providerOf(packId: string | null): string | null;
  /** Whether the pack's sign-in is human only (never filled by the vault). */
  humanOnly(packId: string | null): boolean;
  /** The pack that owns a site, in force or on offer (creation checks, spec 13 §11.1). */
  packIdFor?(siteId: string): string | null;
  /** The content in force, else the offered one. */
  detail?(packId: string): { readonly pack: SitePackV1 | null };
  /**
   * What the pack in force for a site's `pack_id` selects that a template with `settings` cannot
   * apply in full on this machine (spec 13 §9.4; D49, D50); absent or `[]` without one.
   */
  strategyNotes?(packId: string | null, settings: StrategyNoteSettings): TemplateStrategyNote[];
}

/** A refusal a site's pack causes (spec 13 §11.1 `POST /templates` 400 cases, §9.4 `stealth-profile`). */
export interface PackRequirementIssue {
  readonly path: string;
  readonly message: string;
  readonly code: 'headed_required' | 'human_only_stealth_off' | StealthFloorIssue['code'];
}

/** The template settings the pack requirements read. */
export type PackRequirementSettings = StealthSettings & { readonly headless: boolean };

/**
 * The refusals of spec 13 §11.1 that depend on a site's pack: a headless template with a pack whose
 * `browser.headed` is `required`, stealth `off` with a `human_only` pack, and a template below the
 * pack's `stealth-profile` floor (stealth level, fingerprint noise required or forbidden). Each
 * issue's path is `sites[i]`; none under `sitePacks=false` (no pack owns a site).
 */
export function packRequirementIssues(
  packs: TemplatePacks,
  siteIds: readonly string[],
  template: PackRequirementSettings,
): PackRequirementIssue[] {
  const issues: PackRequirementIssue[] = [];
  for (const [i, siteId] of siteIds.entries()) {
    const packId = packs.packIdFor?.(siteId) ?? null;
    if (packId === null || packs.detail === undefined) continue;
    let pack: SitePackV1 | null;
    try {
      pack = packs.detail(packId).pack;
    } catch {
      continue;
    }
    if (pack === null) continue;
    if (template.headless && pack.browser.headed === 'required') {
      issues.push({
        path: `sites[${i}]`,
        code: 'headed_required',
        message: `${pack.title} needs a visible (headed) browser; turn headless off.`,
      });
    }
    if (template.stealth === 'off' && pack.sign_in?.human_only === true) {
      issues.push({
        path: `sites[${i}]`,
        code: 'human_only_stealth_off',
        message: `${pack.title} is signed in by hand only and needs stealth; choose standard or max.`,
      });
    }
    for (const floor of packFloorIssues(template, pack)) {
      issues.push({
        path: `sites[${i}]`,
        code: floor.code,
        message: `${pack.title} ${floor.message}.`,
      });
    }
  }
  return issues;
}

/** No packs: every site is generic. */
export const NO_PACKS: TemplatePacks = {
  prepareSite: () => Promise.resolve(null),
  approvalsCommitted: () => Promise.resolve(),
  sitePackOf: () => null,
  providerOf: () => null,
  humanOnly: () => false,
};

/**
 * The registry as the template services see it on a machine running `platform` (`process.platform`):
 * every {@link TemplatePacks} answer from `registry`, plus the sites' strategy notes from the pack in
 * force (the composition root builds it once).
 */
export function hostTemplatePacks(
  registry: TemplatePacks & Pick<SitePackLookup, 'effectiveById'>,
  platform: string,
): TemplatePacks {
  return {
    prepareSite: (siteId, sha256, by) => registry.prepareSite(siteId, sha256, by),
    approvalsCommitted: () => registry.approvalsCommitted(),
    sitePackOf: (packId) => registry.sitePackOf(packId),
    providerOf: (packId) => registry.providerOf(packId),
    humanOnly: (packId) => registry.humanOnly(packId),
    packIdFor: (siteId) => registry.packIdFor?.(siteId) ?? null,
    ...(registry.detail !== undefined && {
      detail: (packId: string) => registry.detail?.(packId) ?? { pack: null },
    }),
    strategyNotes: (packId, settings) => {
      const effective = packId === null ? null : registry.effectiveById(packId);
      return effective === null ? [] : strategyNotesOf(effective.pack, settings, platform);
    },
  };
}

/** The reviewed hashes of `POST /templates` sites, by registrable domain. */
export function reviewedHashes(
  sites: readonly { readonly site_id: string; readonly pack_sha256?: string | undefined }[],
): (siteId: string) => string | undefined {
  const map = new Map<string, string>();
  for (const s of sites) {
    if (s.pack_sha256 !== undefined)
      map.set(registrableDomain(s.site_id) || s.site_id, s.pack_sha256);
  }
  return (siteId) => map.get(siteId);
}

/** The identity-provider lookup `domain/templates/probe.ts` takes. */
export function providerLookup(packs: TemplatePacks): (packId: string) => string | null {
  return (packId) => packs.providerOf(packId);
}

/**
 * Prepares the first-use approval of each new site (spec 13 §9.6) and records the pack on the site
 * (`pack_id`, `pack_version`). The approvals are written by the caller in the sites' transaction.
 */
export async function prepareSiteApprovals(
  packs: TemplatePacks,
  sites: readonly TemplateSiteRecord[],
  shaOf: (siteId: string) => string | undefined,
  by: string,
): Promise<{ sites: TemplateSiteRecord[]; approvals: PreparedApproval[] }> {
  const out: TemplateSiteRecord[] = [];
  const approvals: PreparedApproval[] = [];
  for (const site of sites) {
    const approval = await packs.prepareSite(site.siteId, shaOf(site.siteId), by);
    if (approval !== null) approvals.push(approval);
    out.push(
      approval === null
        ? site
        : { ...site, packId: approval.packId, packVersion: approval.version },
    );
  }
  return { sites: out, approvals };
}

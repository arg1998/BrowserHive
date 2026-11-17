/** @module app/templates/site-prober — the probe seam (spec 13 §8.1): one `SiteProber` per kind of site. T2 ships the generic cookie probe for every site; T3a adds the pack prober (cookie pre-check with the pack's `cookie_names`, then a `GET` navigation in a maintenance page that can answer `challenged`) and selects it for sites with a pack. */

import { classifyGenericProbe, type ProbeVerdict } from '../../domain/templates/probe.ts';
import type { TemplateRecord, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { TemplateHost } from '../../ports/template-host.ts';

/** What a prober gets: the template, the site, its running browser and the probe's deadline. */
export interface SiteProbeContext {
  readonly template: TemplateRecord;
  readonly site: TemplateSiteRecord;
  /** The template's running browser. A navigation prober opens its page through BrowserHive's own maintenance session, never in an agent's window. */
  readonly host: TemplateHost;
  readonly now: number;
  readonly signal: AbortSignal;
}

/**
 * One way to tell whether a site is signed in. MUST NOT read a cookie value, MUST issue only `GET`
 * navigations to the site's own probe path (packs, T3a), and MUST report a challenge as
 * `challenged`, never as `signed_out` (spec 13 §8.1).
 */
export interface SiteProber {
  probe(ctx: SiteProbeContext): Promise<ProbeVerdict>;
}

/** Chooses the prober of a site (T3a: the pack prober when `site.packId` is set). */
export type ProberSelector = (site: TemplateSiteRecord) => SiteProber;

/** The generic cookie probe: the jar's names and expiry against the site's learned names (§8.1 step 3). */
export const GENERIC_PROBER: SiteProber = {
  async probe(ctx) {
    const jar = await ctx.host.jar();
    return classifyGenericProbe(ctx.site, jar, ctx.now);
  },
};

/** T2: every site is generic (spec 13 §17 T2). */
export const selectGenericProber: ProberSelector = () => GENERIC_PROBER;

/** @module app/site-packs/pack-prober — the pack prober of spec 13 §8.1 through T2's probe seam: the cookie pre-check with the pack's `cookie_names`, then one `GET` navigation to `https://<probe.host><probe.path>` in a page of BrowserHive's own maintenance session (minimized, never an agent's window), with a guard that aborts every main-frame document request leaving the pack's domains (fail-closed), classified by `classifyPackProbe`. */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import type { Page, Route } from 'patchright';
import {
  type ChallengeProvider,
  challengeRulesFor,
  firstChallenge,
  isChallengePath,
  isVisibleSurface,
  providerOfFrameUrl,
} from '../../domain/site-packs/challenges.ts';
import {
  classifyPackProbe,
  inPackDomains,
  PACK_PROBE_REASONS,
  PROBE_NAVIGATION_MS,
  packCookiePrecheck,
  probeUrlOf,
} from '../../domain/site-packs/probe-classify.ts';
import { hostOf } from '../../domain/site-packs/site-of-url.ts';
import type { ProbeVerdict } from '../../domain/templates/probe.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { TemplateRecord, TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import {
  GENERIC_PROBER,
  type ProberSelector,
  type SiteProbeContext,
  type SiteProber,
} from '../templates/site-prober.ts';

/** How long the probe page may settle after `domcontentloaded` (provider frames load). */
export const PROBE_SETTLE_MS = 5_000;

/** A page of BrowserHive's own maintenance session, opened for one probe. */
export interface ProbePage {
  readonly page: Page;
  /** Closes the page's session; idempotent. */
  close(): Promise<void>;
}

/** Collaborators of {@link PackProber}. */
export interface PackProberDeps {
  readonly lookup: () => SitePackLookup | null;
  /** Opens a minimized maintenance page on the template's running browser. */
  readonly openPage: (
    template: TemplateRecord,
    site: TemplateSiteRecord,
    signal: AbortSignal,
  ) => Promise<ProbePage>;
  readonly logger: Logger;
}

/** The pack prober (`needsBrowser`: a stopped browser is started for it). */
export class PackProber implements SiteProber {
  readonly needsBrowser = true;
  readonly #deps: PackProberDeps;
  readonly #log: Logger;

  constructor(deps: PackProberDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'site-packs.prober' });
  }

  async probe(ctx: SiteProbeContext): Promise<ProbeVerdict> {
    const packId = ctx.site.packId;
    const effective = packId === null ? null : (this.#deps.lookup()?.effectiveById(packId) ?? null);
    // The pack went away (disabled, `sitePacks=false`) since the selection: the generic probe.
    if (effective === null) return await GENERIC_PROBER.probe(ctx);
    const pack = effective.pack;
    const precheck = packCookiePrecheck(pack, await ctx.jar(), ctx.now);
    if (precheck !== null) return precheck;
    if (ctx.signal.aborted) return inconclusive(PACK_PROBE_REASONS.timeout);
    const opened = await this.#deps.openPage(ctx.template, ctx.site, ctx.signal);
    const onAbort = () => void opened.close().catch(() => undefined);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.#navigate(pack, opened.page);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      await opened.close().catch(() => undefined);
    }
  }

  async #navigate(pack: SitePackV1, page: Page): Promise<ProbeVerdict> {
    try {
      await page.route('**/*', (route) => guardDocument(pack, page, route));
    } catch (err) {
      // Fail-closed: without the domain guard the probe does not navigate.
      this.#log.warn('probe guard not installed', { err: serializeError(err) });
      return inconclusive(PACK_PROBE_REASONS.network);
    }
    let failure: 'timeout' | 'network' | null = null;
    let status: number | null = null;
    try {
      const response = await page.goto(probeUrlOf(pack), {
        waitUntil: 'domcontentloaded',
        timeout: PROBE_NAVIGATION_MS,
      });
      status = response?.status() ?? null;
    } catch (err) {
      failure = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network';
    }
    if (failure === null) {
      await page.waitForLoadState('load', { timeout: PROBE_SETTLE_MS }).catch(() => undefined);
    }
    const finalUrl = safeUrl(page);
    const challenge = failure === null ? await this.#challenge(pack, page, finalUrl) : null;
    return await classifyPackProbe(pack, {
      failure,
      finalUrl,
      status,
      challenge,
      hasSelector: async (selector) => (await page.locator(`css=${selector}`).count()) > 0,
    });
  }

  /** The first challenge the probe page matches (the page's pack, else the site's; then defaults). */
  async #challenge(pack: SitePackV1, page: Page, url: string) {
    try {
      const host = hostOf(url);
      const owner = host === null ? null : (this.#deps.lookup()?.effectiveFor(host)?.pack ?? null);
      const rules = challengeRulesFor(owner ?? (inPackDomains(pack, url) ? pack : null));
      const rule = await firstChallenge(rules, {
        url,
        urlExempt: false,
        surfaces: await surfacesOf(page),
        title: () => page.title(),
        hasLandmark: async (selector) => (await page.locator(`css=${selector}`).count()) > 0,
        hasText: async (text) => (await page.getByText(text).count()) > 0,
      });
      return rule?.kind ?? null;
    } catch (err) {
      this.#log.debug('probe challenge skipped', { err: serializeError(err) });
      return null;
    }
  }
}

/** Aborts a main-frame document request outside the pack's domains (§9.10); everything else goes on. */
async function guardDocument(pack: SitePackV1, page: Page, route: Route): Promise<void> {
  const request = route.request();
  const leaving =
    request.resourceType() === 'document' &&
    request.frame() === page.mainFrame() &&
    !inPackDomains(pack, request.url());
  try {
    if (leaving) await route.abort('blockedbyclient');
    else await route.fallback();
  } catch {
    // The page closed meanwhile.
  }
}

/** Providers with a challenge surface among the page's frames now (one visibility check). */
async function surfacesOf(page: Page): Promise<ReadonlySet<ChallengeProvider>> {
  const found = new Set<ChallengeProvider>();
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const provider = providerOfFrameUrl(frame.url());
    if (provider === null || found.has(provider)) continue;
    if (isChallengePath(provider, frame.url())) {
      found.add(provider);
      continue;
    }
    try {
      const element = await frame.frameElement();
      const visible = await element.isVisible();
      const box = await element.boundingBox();
      await element.dispose();
      if (isVisibleSurface(box, visible, page.viewportSize())) found.add(provider);
    } catch {
      // A detached frame is no surface.
    }
  }
  return found;
}

function inconclusive(reason: string): ProbeVerdict {
  return { outcome: 'inconclusive', reason, finalUrl: null };
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

/**
 * Picks the pack prober for sites attached to a pack that is in force (lead decision 6: `pack_id`
 * set at add time), the generic probe for every other site.
 */
export function packProberSelector(
  prober: PackProber,
  lookup: () => SitePackLookup | null,
  fallback: ProberSelector,
): ProberSelector {
  return (site) =>
    site.packId !== null && lookup()?.effectiveById(site.packId) != null ? prober : fallback(site);
}

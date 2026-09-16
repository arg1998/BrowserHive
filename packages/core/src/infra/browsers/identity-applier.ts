/** @module infra/browsers/identity-applier — applies the CDP `Emulation.setUserAgentOverride` per page (WeakMap-tracked, replayed on `context.on('page')`, detached on close). */

import type { BrowserContext, CDPSession, Page } from 'playwright';
import { z } from 'zod';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { AppliedDisplay, AppliedIdentity, GeoSeed } from '../../ports/browser-driver.ts';
import type { Logger } from '../../ports/logger.ts';
import type { HostFacts } from './host-facts.ts';
import { type CoherentIdentity, deriveCoherentIdentity } from './stealth-identity.ts';

const BrowserVersion = z.object({
  product: z.string().optional(),
  userAgent: z.string().optional(),
});

interface PageState {
  readonly cdp: CDPSession | null;
  readonly ready: Promise<void>;
}

/** The CDP parameter bag as a plain mutable object (the protocol typings want mutable arrays). */
function cdpParamsFor(override: CoherentIdentity['override']): {
  userAgent: string;
  platform: string;
  userAgentMetadata: {
    brands: { brand: string; version: string }[];
    fullVersionList: { brand: string; version: string }[];
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
  acceptLanguage?: string;
} {
  const m = override.userAgentMetadata;
  return {
    userAgent: override.userAgent,
    platform: override.platform,
    userAgentMetadata: {
      brands: m.brands.map((b) => ({ ...b })),
      fullVersionList: m.fullVersionList.map((b) => ({ ...b })),
      fullVersion: m.fullVersion,
      platform: m.platform,
      platformVersion: m.platformVersion,
      architecture: m.architecture,
      model: m.model,
      mobile: m.mobile,
      bitness: m.bitness,
      wow64: m.wow64,
    },
    ...(override.acceptLanguage !== undefined && { acceptLanguage: override.acceptLanguage }),
  };
}

/** Inputs to {@link IdentityApplier.apply}: the geo story and (metadata only) the asserted display. */
export interface ApplyIdentityInput {
  readonly geo: GeoSeed | null;
  readonly display: AppliedDisplay | null;
}

/**
 * Owns the session's UA override. `Emulation.setUserAgentOverride` is **page-scoped and reverted
 * when its CDP session detaches**, so the applier keeps one CDP session per page for the page's
 * lifetime and replays the same override to every new page (agent tabs and site-opened popups
 * alike). Sessions live in a `WeakMap<Page, { cdp, ready }>` and are detached on `page.on('close')`
 * (spec 11 §2.3), so closed pages release their CDP sessions instead of accumulating.
 */
export class IdentityApplier {
  private readonly context: BrowserContext;
  private readonly host: HostFacts;
  private readonly logger: Logger;
  private readonly pages = new WeakMap<Page, PageState>();
  /** Pages with a live CDP session, so `dispose()` can detach them (a WeakMap is not iterable). */
  private readonly live = new Set<Page>();
  private override: CoherentIdentity['override'] | undefined;
  private disposed = false;

  constructor(
    context: BrowserContext,
    deps: { readonly host: HostFacts; readonly logger: Logger },
  ) {
    this.context = context;
    this.host = deps.host;
    this.logger = deps.logger.child({ module: 'browsers.identity' });
  }

  /**
   * Derive the identity from the real browser (`Browser.getVersion` over CDP) and apply it to
   * `page` **before first navigation**; then hook `context.on('page')` so every later page is
   * covered. Throws when the first application fails so the launcher can record `STEALTH_INIT_FAILED`.
   */
  async apply(page: Page, input: ApplyIdentityInput): Promise<AppliedIdentity> {
    const cdp = await this.context.newCDPSession(page);
    const version = BrowserVersion.parse(await cdp.send('Browser.getVersion'));
    const derived = deriveCoherentIdentity({
      product: version.product ?? '',
      userAgent: version.userAgent ?? '',
      hostPlatform: this.host.platform,
      hostArch: this.host.arch,
      hostRelease: this.host.release,
      geo: input.geo,
      display: input.display,
    });
    this.override = derived.override;
    await cdp.send('Emulation.setUserAgentOverride', cdpParamsFor(derived.override));
    this.track(page, { cdp, ready: Promise.resolve() });

    // Cover every page opened from here on — agent tabs and site-opened popups alike.
    this.context.on('page', (opened) => {
      void this.ensureForPage(opened);
    });
    return derived.applied;
  }

  /**
   * Ensure the derived UA override has been applied to `page`, and resolve once it has.
   *
   * Idempotent and **awaitable**, which is the point. The `page` event handler starts this work
   * fire-and-forget, but a caller that is about to navigate a tab it just opened must be able to wait
   * for it: `new_tab` creates a page and can navigate on the very next line, and an override that
   * lands after that first request went out is an override that did not happen — the tab's opening
   * navigation would carry the raw `HeadlessChrome` UA and un-relabelled client hints. Returning the
   * *same* promise to both callers is what makes the wait correct rather than merely likely.
   *
   * Failures are swallowed: this also runs from an event handler, where a rejection would be an
   * unhandled promise, and the page may already have closed. A tab that misses the override presents
   * the honest baseline — a degradation, not a fault.
   */
  ensureForPage(page: Page): Promise<void> {
    if (this.disposed || this.override === undefined) return Promise.resolve();
    const existing = this.pages.get(page);
    if (existing !== undefined) return existing.ready;
    const state: PageState = { cdp: null, ready: this.applyToPage(page) };
    this.pages.set(page, state);
    return state.ready;
  }

  /** Detach every live CDP session (harmless if the context is already tearing down). */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.override = undefined;
    for (const page of [...this.live]) await this.detach(page);
  }

  private async applyToPage(page: Page): Promise<void> {
    const override = this.override;
    if (override === undefined) return;
    try {
      const cdp = await this.context.newCDPSession(page);
      await cdp.send('Emulation.setUserAgentOverride', cdpParamsFor(override));
      this.track(page, { cdp, ready: Promise.resolve() });
    } catch (err) {
      // Page already closed, or CDP unavailable for this target.
      this.logger.debug('identity replay skipped', { err: serializeError(err) });
    }
  }

  private track(page: Page, state: PageState): void {
    this.pages.set(page, state);
    if (state.cdp !== null) {
      this.live.add(page);
      page.once('close', () => {
        void this.detach(page);
      });
    }
  }

  private async detach(page: Page): Promise<void> {
    const state = this.pages.get(page);
    this.live.delete(page);
    this.pages.delete(page);
    if (state?.cdp === null || state === undefined) return;
    try {
      await state.cdp.detach();
    } catch {
      // Context/page already gone — nothing to detach.
    }
  }
}

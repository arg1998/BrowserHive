/** @module app/site-packs/strategies/entry-warmup — `entry-warmup` (spec 13 §9.4, §9.10): a session's first navigation to a site that goes straight to a deep page first loads the pack's entry path with the chosen `Referer` and dwells there. The warm-up load aborts every main-frame document leaving the pack's domains (fail-closed, as the pack prober does), stays within half the tool's timeout, and never fails the agent's navigation. */

import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import type { Route } from 'patchright';
import { inPackDomains } from '../../../domain/site-packs/probe-classify.ts';
import type { StrategyParams } from '../../../domain/site-packs/strategy-specs.ts';
import { assertNever } from '../../../kernel/errors/app-error.ts';
import { serializeError } from '../../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../../ports/clock.ts';
import type { Logger } from '../../../ports/logger.ts';
import type { Page } from '../../../ports/page-types.ts';

/** The search engine a `referrer: 'search'` warm-up names. */
export const SEARCH_REFERRER = 'https://www.google.com/';
/** The longest warm-up load. */
export const WARMUP_LOAD_MAX_MS = 15_000;
/** A warm-up whose load would get less than this is skipped. */
export const WARMUP_LOAD_MIN_MS = 1_000;

/** What a warm-up loads. */
export interface WarmupPlan {
  readonly url: string;
  /** `undefined`: no `Referer`. */
  readonly referer: string | undefined;
  readonly dwellMs: number;
}

/**
 * The warm-up before a navigation to `target`, or `null` when `target` is not a deep link (its
 * path is `/` or the entry path). The host is the target's when it is the pack's `www.<first
 * domain>` or probe host, else the probe host.
 */
export function warmupPlan(
  pack: {
    readonly domains: readonly string[];
    readonly signed_in: { readonly probe: { readonly host: string } };
  },
  params: StrategyParams['entry-warmup'],
  target: string,
): WarmupPlan | null {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  if (parsed.pathname === '/' || parsed.pathname === params.path) return null;
  const targetHost = parsed.hostname.toLowerCase();
  const probeHost = pack.signed_in.probe.host;
  const www = `www.${pack.domains[0] ?? ''}`;
  const host = targetHost === www || targetHost === probeHost ? targetHost : probeHost;
  return {
    url: `https://${host}${params.path}`,
    referer: refererOf(params.referrer, host),
    dwellMs: params.dwellMs,
  };
}

function refererOf(
  referrer: StrategyParams['entry-warmup']['referrer'],
  host: string,
): string | undefined {
  switch (referrer) {
    case 'none':
      return undefined;
    case 'same-site':
      return `https://${host}/`;
    case 'search':
      return SEARCH_REFERRER;
    default:
      return assertNever(referrer);
  }
}

/**
 * The budget of a warm-up inside a tool whose timeout is `timeoutMs` (`0`: none): half the
 * timeout, the load capped at {@link WARMUP_LOAD_MAX_MS}; `null` when the load would get less
 * than {@link WARMUP_LOAD_MIN_MS}.
 */
export function warmupBudget(
  timeoutMs: number,
  dwellMs: number,
): { readonly loadMs: number; readonly dwellMs: number } | null {
  const total = timeoutMs === 0 ? WARMUP_LOAD_MAX_MS + dwellMs : Math.floor(timeoutMs / 2);
  const loadMs = Math.min(WARMUP_LOAD_MAX_MS, total - dwellMs);
  return loadMs < WARMUP_LOAD_MIN_MS ? null : { loadMs, dwellMs };
}

/** Runs warm-ups in an agent's page. */
export class EntryWarmup {
  readonly #clock: Clock;
  readonly #log: Logger;

  constructor(clock: Clock, logger: Logger) {
    this.#clock = clock;
    this.#log = logger;
  }

  /**
   * Loads `plan.url` in `page` behind the domain guard, then dwells with the guard still in place.
   * Resolves when done or failed (failures are logged; the agent's navigation goes on).
   *
   * @throws the signal's reason when the call is aborted
   */
  async run(
    page: Page,
    pack: Pick<SitePackV1, 'id' | 'domains'>,
    plan: WarmupPlan,
    budget: { readonly loadMs: number; readonly dwellMs: number },
    signal: AbortSignal,
  ): Promise<void> {
    const guard = (route: Route) => guardDocument(pack, page, route);
    try {
      await page.route('**/*', guard);
    } catch (err) {
      // Fail-closed: without the domain guard the warm-up does not load anything.
      this.#log.warn('warm-up guard failed', {
        pack: pack.id,
        err: serializeError(err),
      });
      return;
    }
    try {
      try {
        await page.goto(plan.url, {
          waitUntil: 'domcontentloaded',
          timeout: budget.loadMs,
          ...(plan.referer !== undefined && { referer: plan.referer }),
        });
      } catch (err) {
        this.#log.warn('entry warm-up failed', { pack: pack.id, err: serializeError(err) });
        // A load still running (a slow page, a redirect chain) stops before the guard goes away.
        await page.evaluate('window.stop()').catch(() => undefined);
        if (signal.aborted) throw signal.reason;
        return;
      }
      // The guard stays through the dwell: the page's own navigations stay inside the domains.
      await this.#clock.sleep(budget.dwellMs, signal);
    } finally {
      await page.unroute('**/*', guard).catch(() => undefined);
    }
  }
}

/** Aborts a main-frame document request outside the pack's domains (§9.10); everything else goes on. */
async function guardDocument(
  pack: Pick<SitePackV1, 'domains'>,
  page: Page,
  route: Route,
): Promise<void> {
  try {
    if (leavesPack(pack, page, route)) await route.abort('blockedbyclient');
    else await route.fallback();
  } catch {
    // The page closed meanwhile.
  }
}

function leavesPack(pack: Pick<SitePackV1, 'domains'>, page: Page, route: Route): boolean {
  const request = route.request();
  if (request.resourceType() !== 'document') return false;
  try {
    return request.frame() === page.mainFrame() && !inPackDomains(pack, request.url());
  } catch {
    // A request without a frame (a service worker's) is no main-frame document.
    return false;
  }
}

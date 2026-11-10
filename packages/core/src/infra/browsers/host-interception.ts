/** @module infra/browsers/host-interception — a template host's own interception pieces (spec 13 §3.8): the self-origin guard (handler 1) and the per-request owner resolver over the host's page attribution. */

import type { Page, Request } from 'playwright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { isSelfAddress, selfAddressesOf, TEMPLATE_HOST_COOKIE } from '../../kernel/self-address.ts';
import type { CookieInput } from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { RequestOwner } from '../../ports/request-guard.ts';
import type {
  InterceptionHandler,
  InterceptionVerdict,
  OwnerResolver,
} from './interception-chain.ts';
import { PASS } from './interception-chain.ts';
import type { PageOwner } from './page-attribution.ts';
import { ATTRIBUTION_HOLD_MS } from './page-dispatcher.ts';

const ABORT_BLOCKED: InterceptionVerdict = Object.freeze({
  kind: 'abort',
  reason: 'blockedbyclient',
});

/** How often a frameless navigation is re-read while its page is being adopted. */
const OWNER_POLL_MS = 25;

/**
 * Handler 1 of a template host's chain: aborts every request, of every method and resource type,
 * to BrowserHive itself ({@link isSelfAddress}), so the dashboard never loads in a host window and
 * its session cookie never enters a template's jar (spec 13 §3.8). Fail-closed for every type: a
 * request it cannot read is aborted. A redirect hop is not routed (Playwright routes the first URL
 * only); the daemon refuses those itself (the template-host marker cookie, `templateHostCookies`).
 */
export function selfOriginHandler(deps: {
  readonly origins: readonly string[];
  readonly logger: Logger;
}): InterceptionHandler {
  const self = selfAddressesOf(deps.origins);
  const log = deps.logger.child({ module: 'self-origin' });
  return {
    id: 'self-origin',
    onError: 'closed',
    handle: async (request: Request) => {
      try {
        if (!isSelfAddress(request.url(), self)) return PASS;
        log.info('own origin blocked');
        return ABORT_BLOCKED;
      } catch (err) {
        log.error('self-origin check threw', { err: serializeError(err) });
        return { kind: 'abort', reason: 'failed' };
      }
    },
  };
}

export {
  isSelfAddress,
  type SelfAddresses,
  selfAddressesOf,
  TEMPLATE_HOST_COOKIE,
} from '../../kernel/self-address.ts';

/**
 * The marker cookies a template host carries for each of BrowserHive's own origins: sent on every
 * request to them, redirect hops included, so the daemon can refuse what the route never sees.
 * HttpOnly (no page script can remove it); `Lax` so a cross-site top-level navigation carries it.
 */
export function templateHostCookies(origins: readonly string[]): CookieInput[] {
  const cookies: CookieInput[] = [];
  const seen = new Set<string>();
  for (const raw of origins) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (seen.has(url.origin)) continue;
      seen.add(url.origin);
      cookies.push({
        name: TEMPLATE_HOST_COOKIE,
        value: '1',
        url: url.origin,
        httpOnly: true,
        sameSite: 'Lax',
        expires: -1,
      });
    } catch {
      // Not a URL.
    }
  }
  return cookies;
}

/** What the resolver reads from the host's attribution. */
export interface AttributionReader {
  /** The decided attribution of `page`, open or closed; `undefined` while it is undecided. */
  attributionOf(page: Page): PageOwner | undefined;
}

/**
 * The owner of a request on a template host (spec 13 §3.8 "Owner of a request"):
 * - a service worker's request, or one with no page → the host;
 * - a request of a page → that page's attribution (a parked page → the host);
 * - a navigation whose frame does not exist yet (a popup's first request) is held until its page
 *   is attributed, at most {@link ATTRIBUTION_HOLD_MS}, then the host.
 *
 * The chain calls it lazily, only for handlers that need an owner, and memoizes it per request.
 */
export function hostOwnerResolver(deps: {
  readonly attribution: AttributionReader;
  readonly clock: Clock;
  readonly holdMs?: number;
}): OwnerResolver {
  const holdMs = deps.holdMs ?? ATTRIBUTION_HOLD_MS;
  return async (request) => {
    if (request.serviceWorker() !== null) return HOST;
    const until = deps.clock.now() + holdMs;
    for (;;) {
      const page = pageOf(request);
      if (page === null) return HOST;
      const owner = page === undefined ? undefined : deps.attribution.attributionOf(page);
      if (owner !== undefined) return toRequestOwner(owner);
      // No frame yet (a popup's first navigation) or a page still being decided: wait for it.
      if (deps.clock.now() >= until) return HOST;
      await deps.clock.sleep(OWNER_POLL_MS);
    }
  };
}

const HOST: RequestOwner = Object.freeze({ kind: 'host' });

/** The request's page; `undefined` while its frame is not attached yet; `null` when it has none. */
function pageOf(request: Request): Page | null | undefined {
  try {
    return request.frame().page();
  } catch {
    // Playwright throws for a navigation request whose frame is not attached yet.
    return request.isNavigationRequest() ? undefined : null;
  }
}

function toRequestOwner(owner: PageOwner): RequestOwner {
  return owner.kind === 'session' ? { kind: 'session', sessionId: owner.sessionId } : HOST;
}

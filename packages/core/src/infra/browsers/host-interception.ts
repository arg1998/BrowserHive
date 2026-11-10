/** @module infra/browsers/host-interception — a template host's own interception pieces (spec 13 §3.8): the self-origin guard (handler 1) and the per-request owner resolver over the host's page attribution. */

import type { Page, Request } from 'playwright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
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

/** The canonical origin of `raw` (`scheme://host:port`, default ports dropped), or `null`. */
export function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Handler 1 of a template host's chain: aborts every request, of every method and resource type,
 * to BrowserHive's own origins, so the dashboard never loads in a host window and its session cookie
 * never enters a template's jar (spec 13 §3.8). Fail-closed for every type: a request it cannot
 * read is aborted.
 */
export function selfOriginHandler(deps: {
  readonly origins: readonly string[];
  readonly logger: Logger;
}): InterceptionHandler {
  const origins = new Set(
    deps.origins.map(originOf).filter((origin): origin is string => origin !== null),
  );
  const log = deps.logger.child({ module: 'self-origin' });
  return {
    id: 'self-origin',
    onError: 'closed',
    handle: async (request: Request) => {
      try {
        const origin = originOf(request.url());
        if (origin === null || !origins.has(origin)) return PASS;
        log.info('own origin blocked', { origin });
        return ABORT_BLOCKED;
      } catch (err) {
        log.error('self-origin check threw', { err: serializeError(err) });
        return { kind: 'abort', reason: 'failed' };
      }
    },
  };
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

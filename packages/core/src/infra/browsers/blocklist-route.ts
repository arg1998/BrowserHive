/** @module infra/browsers/blocklist-route — network-layer blocklist enforcement: `context.route('**\/*')` aborting matching document loads, fail-closed (spec 11 §5, D-22). */

import type { BlockedSource } from '@browserhive/contracts/enums';
import type { BrowserContext, Route } from 'playwright';
import type { Blocklist } from '../../domain/policies/blocklist.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { LaunchWarning } from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';

/** One blocked navigation, reported to the audit sink (`blocklist_hits`, `source: 'request'`). */
export interface BlockedUrlHit {
  readonly sessionId: string;
  readonly url: string;
  readonly pattern: string;
  readonly source: BlockedSource;
  readonly ts: number;
}

/** Sink for blocked navigations. The sessions service turns hits into audit rows and events. */
export interface BlockedUrlObserver {
  blocked(hit: BlockedUrlHit): void;
}

/** Collaborators of {@link installBlocklistRoute}. */
export interface BlocklistRouteDeps {
  /** The live holder: the handler reads the *current* rules on every request (hot reload). */
  readonly blocklist: Blocklist;
  readonly observer: BlockedUrlObserver;
  readonly sessionId: string;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Arm the blocklist route before anything can navigate, so the very first page load is already
 * covered. The route handler is the first entry of the `InterceptionChain` seam.
 *
 * Scoped to `document` requests on purpose. A blocklist entry describes a *place an agent may not
 * go*, so aborting the page load is the whole enforcement; extending it to images, scripts and XHR
 * would let a rule about one CDN quietly break every allowed page that happens to load from it.
 *
 * Installed when a blocklist is *configured* (the holder exists), even if currently empty: a reload
 * that adds entries must reach live sessions (D-22). A hive without a blocklist passes `null`
 * upstream and pays no interception cost.
 *
 * A handler exception **fails closed** for document requests: the request is aborted rather than
 * allowed through a broken policy check, because failing open would silently disable the blocklist. Route install failure is returned as
 * the `BLOCKLIST_ROUTE_FAILED` warning — the tool-level check still stands; say so rather than pretend.
 */
export async function installBlocklistRoute(
  context: BrowserContext,
  deps: BlocklistRouteDeps,
): Promise<LaunchWarning | null> {
  const log = deps.logger.child({ module: 'blocklist', sessionId: deps.sessionId });
  try {
    await context.route('**/*', async (route: Route) => {
      const passThrough = async (): Promise<void> => {
        try {
          // `fallback` hands off to any other handler in the chain (and then Playwright's default).
          await route.fallback();
        } catch {
          // The page navigated away mid-flight — the request is already moot.
        }
      };
      const abort = async (reason: 'blockedbyclient' | 'failed'): Promise<void> => {
        try {
          await route.abort(reason);
        } catch {
          // Already handled or gone.
        }
      };
      let isDocument = false;
      try {
        const request = route.request();
        isDocument = request.resourceType() === 'document';
        if (!isDocument) return await passThrough();
        const url = request.url();
        const hit = deps.blocklist.match(url);
        if (hit === null) return await passThrough();
        deps.observer.blocked({
          sessionId: deps.sessionId,
          url,
          pattern: hit.pattern,
          source: 'request',
          ts: deps.clock.now(),
        });
        log.info('blocked navigation', { url, pattern: hit.pattern });
        await abort('blockedbyclient');
      } catch (err) {
        log.error('blocklist handler threw', { err: serializeError(err) });
        // Fail closed for the class of request the policy governs; subresources stay untouched.
        if (isDocument) await abort('failed');
        else await passThrough();
      }
    });
    return null;
  } catch (err) {
    return {
      code: 'BLOCKLIST_ROUTE_FAILED',
      message:
        'could not install the blocklist route handler; the navigation tools are still checked, ' +
        'but in-page navigations to blocked URLs will not be intercepted',
      details: { error: serializeError(err) },
    };
  }
}

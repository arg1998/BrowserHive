/** @module infra/browsers/blocklist-route — network-layer blocklist enforcement: the interception chain's handler aborting matching document loads, fail-closed (spec 11 §5, D-22). */

import type { BlockedSource } from '@browserhive/contracts/enums';
import type { BrowserContext, Request } from 'playwright';
import type { Blocklist } from '../../domain/policies/blocklist.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { LaunchWarning } from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import {
  fixedOwner,
  InterceptionChain,
  type InterceptionHandler,
  type InterceptionVerdict,
  PASS,
} from './interception-chain.ts';

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
 * The blocklist as the chain's blocking handler (spec 11 §5, spec 13 §3.8 handler 2).
 *
 * Scoped to `document` requests on purpose. A blocklist entry describes a *place an agent may not
 * go*, so aborting the page load is the whole enforcement; extending it to images, scripts and XHR
 * would let a rule about one CDN quietly break every allowed page that happens to load from it.
 * Requests by method and resource type are the request guard's (spec 13 §9.3).
 *
 * A handler exception **fails closed** for document requests: the request is aborted rather than
 * allowed through a broken policy check, because failing open would silently disable the
 * blocklist. The handler catches its own failures so the log line stays `blocklist handler threw`.
 */
export function blocklistHandler(deps: BlocklistRouteDeps): InterceptionHandler {
  const log = deps.logger.child({ module: 'blocklist', sessionId: deps.sessionId });
  return {
    id: 'blocklist',
    onError: 'closed',
    handle: async (request: Request) => {
      let isDocument = false;
      try {
        isDocument = request.resourceType() === 'document';
        if (!isDocument) return PASS;
        const url = request.url();
        const hit = deps.blocklist.match(url);
        if (hit === null) return PASS;
        deps.observer.blocked({
          sessionId: deps.sessionId,
          url,
          pattern: hit.pattern,
          source: 'request',
          ts: deps.clock.now(),
        });
        log.info('blocked navigation', { url, pattern: hit.pattern });
        return ABORT_BLOCKED;
      } catch (err) {
        log.error('blocklist handler threw', { err: serializeError(err) });
        // Fail closed for the class of request the policy governs; subresources stay untouched.
        return isDocument ? ABORT_FAILED : PASS;
      }
    },
  };
}

const ABORT_BLOCKED: InterceptionVerdict = Object.freeze({
  kind: 'abort',
  reason: 'blockedbyclient',
});
const ABORT_FAILED: InterceptionVerdict = Object.freeze({ kind: 'abort', reason: 'failed' });

/**
 * Arm the blocklist before anything can navigate, so the very first page load is already covered:
 * an {@link InterceptionChain} whose only handler is {@link blocklistHandler}.
 *
 * Installed when a blocklist is *configured* (the holder exists), even if currently empty: a reload
 * that adds entries must reach live sessions (D-22). A hive without a blocklist passes `null`
 * upstream and pays no interception cost (and keeps the HTTP cache, which routing disables).
 *
 * Route install failure is returned as the `BLOCKLIST_ROUTE_FAILED` warning — the tool-level check
 * still stands; say so rather than pretend.
 */
export async function installBlocklistRoute(
  context: BrowserContext,
  deps: BlocklistRouteDeps,
): Promise<LaunchWarning | null> {
  const chain = new InterceptionChain({
    handlers: [blocklistHandler(deps)],
    resolveOwner: fixedOwner(deps.sessionId),
    logger: deps.logger,
  });
  const installed = await chain.install(context);
  return installed.ok ? null : blocklistRouteFailed(installed.error);
}

/** The `BLOCKLIST_ROUTE_FAILED` launch warning for a chain carrying the blocklist that could not be installed. */
export function blocklistRouteFailed(error: unknown): LaunchWarning {
  return {
    code: 'BLOCKLIST_ROUTE_FAILED',
    message:
      'could not install the blocklist route handler; the navigation tools are still checked, ' +
      'but in-page navigations to blocked URLs will not be intercepted',
    details: { error: serializeError(error) },
  };
}

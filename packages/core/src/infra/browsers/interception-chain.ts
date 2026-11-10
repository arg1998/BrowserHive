/** @module infra/browsers/interception-chain — one `context.route('**\/*')` per context running ordered in-process handlers: the self-origin guard (T1a), the blocklist, the request guard (spec 13 §3.8, D-22 as amended by D-54). */

import type { BrowserContext, Request, Route } from 'playwright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { err, ok, type Result } from '../../kernel/result.ts';
import type { Logger } from '../../ports/logger.ts';
import type { RequestOwner } from '../../ports/request-guard.ts';

/**
 * Why one route and not one per policy: Playwright runs separately registered route handlers in
 * reverse registration order (the last registered runs first), so the order of several routes is
 * an accident of install order. The chain keeps the order inside one handler, where it is written
 * down: the self-origin guard of a template host, then the blocklist, then the request guard.
 *
 * Installing any route disables Chromium's HTTP cache for the whole context (Playwright turns it
 * off while routing is enabled), so the chain is installed only when something needs it: a
 * configured blocklist today, every template host from PR T1a. An exclusive session without a
 * blocklist gets no route and keeps its cache.
 *
 * What a route cannot see (spec 13 §3.8): the hops of a redirect after its first URL (Playwright
 * routes only the first URL of a redirect chain), WebSocket frames, and requests made from a
 * `javascript:` URL. Popups' first navigation has no frame and, under Playwright, a service
 * worker's requests have none either; that matters to {@link OwnerResolver}, not to matching.
 */

/** A handler's verdict. `abort` ends the chain; `pass` hands the request to the next handler. */
export type InterceptionVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'abort'; readonly reason: 'blockedbyclient' | 'failed' };

/** The `pass` verdict. */
export const PASS: InterceptionVerdict = Object.freeze({ kind: 'pass' });

/** Per-request facts the chain resolves lazily, at most once, for the handlers that need them. */
export interface InterceptionContext {
  /** The request's owner (spec 13 §3.8). Memoized per request. */
  owner(): Promise<RequestOwner>;
}

/**
 * One policy in the chain. A handler decides from the request alone and never calls the route
 * itself: the chain does `fallback` and `abort`, so no handler can end the request twice. A held
 * decision (a `confirm` awaiting an operator) is a handler that has not returned yet.
 */
export interface InterceptionHandler {
  /** Stable name, logged when the handler throws. */
  readonly id: 'self-origin' | 'blocklist' | 'request-guard';
  /**
   * What an exception from {@link handle} does. `closed` (a blocking policy): a `document`
   * request is aborted with `failed`, any other request goes on to the next handler. `open` (an
   * observation): the request goes on. A handler that knows a failed request was one it governs
   * returns its own `abort` instead of throwing.
   */
  readonly onError: 'closed' | 'open';
  handle(request: Request, context: InterceptionContext): Promise<InterceptionVerdict>;
}

/** Resolves a request's owner. Exclusive sessions use {@link fixedOwner}. */
export type OwnerResolver = (request: Request) => Promise<RequestOwner>;

/** The owner resolver of an exclusive session: every request belongs to its one session. */
export function fixedOwner(sessionId: string): OwnerResolver {
  const owner: RequestOwner = Object.freeze({ kind: 'session', sessionId });
  return () => Promise.resolve(owner);
}

/** Collaborators of {@link InterceptionChain}. */
export interface InterceptionChainDeps {
  /** In order; the first `abort` wins. */
  readonly handlers: readonly InterceptionHandler[];
  readonly resolveOwner: OwnerResolver;
  readonly logger: Logger;
}

/** Ordered in-process request handlers behind one route. Build one per context. */
export class InterceptionChain {
  readonly handlers: readonly InterceptionHandler[];
  private readonly resolveOwner: OwnerResolver;
  private readonly log: Logger;
  private installedOn: BrowserContext | null = null;

  constructor(deps: InterceptionChainDeps) {
    this.handlers = [...deps.handlers];
    this.resolveOwner = deps.resolveOwner;
    this.log = deps.logger.child({ module: 'interception' });
  }

  /**
   * Install the one route on `context`, before anything navigates. A second install is refused:
   * two routes would run in reverse order and each would disable the cache again.
   */
  async install(context: BrowserContext): Promise<Result<void, unknown>> {
    if (this.installedOn !== null) return err(new Error('interception chain already installed'));
    try {
      await context.route('**/*', (route: Route) => this.handle(route));
      this.installedOn = context;
      return ok(undefined);
    } catch (error) {
      return err(error);
    }
  }

  /** Run the handlers over one routed request, then pass it on or abort it. Never throws. */
  async handle(route: Route): Promise<void> {
    let request: Request;
    try {
      request = route.request();
    } catch {
      // No request to decide on (the page went away mid-flight): let Playwright handle the route.
      return await fallback(route);
    }
    const context = this.contextFor(request);
    for (const handler of this.handlers) {
      let verdict: InterceptionVerdict;
      try {
        verdict = await handler.handle(request, context);
      } catch (error) {
        this.log.error('interception handler threw', {
          handler: handler.id,
          err: serializeError(error),
        });
        if (handler.onError === 'closed' && isDocument(request))
          return await abort(route, 'failed');
        continue;
      }
      if (verdict.kind === 'abort') return await abort(route, verdict.reason);
    }
    await fallback(route);
  }

  private contextFor(request: Request): InterceptionContext {
    let owner: Promise<RequestOwner> | null = null;
    return {
      owner: () => {
        owner ??= this.resolveOwner(request);
        return owner;
      },
    };
  }
}

/** Whether `request` is a document load; a request that cannot say is not one. */
function isDocument(request: Request): boolean {
  try {
    return request.resourceType() === 'document';
  } catch {
    // The request is gone; nothing left to fail closed on.
    return false;
  }
}

/** `route.fallback()`: the next route handler, then Playwright's default (the network). */
async function fallback(route: Route): Promise<void> {
  try {
    await route.fallback();
  } catch {
    // The page navigated away mid-flight — the request is already moot.
  }
}

async function abort(route: Route, reason: 'blockedbyclient' | 'failed'): Promise<void> {
  try {
    await route.abort(reason);
  } catch {
    // Already handled or gone.
  }
}

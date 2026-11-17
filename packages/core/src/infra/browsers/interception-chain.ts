/** @module infra/browsers/interception-chain — one `context.route('**\/*')` per context running ordered in-process handlers: the self-origin guard (T1a), the blocklist, the request guard (spec 13 §3.8, D-22 as amended by D-54); CORS preflights are sent by Chromium and checked against the site's real answer (D-66). */

import type { BrowserContext, Request, Route } from 'patchright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { err, ok, type Result } from '../../kernel/result.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { RequestOwner } from '../../ports/request-guard.ts';
import {
  installPreflightHook,
  type PreflightHook,
  type PreflightRequest,
  type PreflightVerdict,
} from './driver-preflights.ts';
import { PreflightCache } from './preflight-cache.ts';

/**
 * Why one route and not one per policy: Playwright runs separately registered route handlers in
 * reverse registration order (the last registered runs first), so the order of several routes is
 * an accident of install order. The chain keeps the order inside one handler and fixes it by
 * handler id ({@link HANDLER_ORDER}), whatever order handlers are given or registered in: the
 * self-origin guard of a template host, then the blocklist, then the request guard.
 *
 * Routing side effects (Playwright, while any route is installed on the context):
 * - **No HTTP cache.** Chromium's cache is disabled for the whole context, so the chain is
 *   installed only when something needs it: a configured blocklist today, every template host
 *   from PR T1a. An exclusive session without a blocklist gets no route and keeps its cache.
 * - **CORS preflights stay real (D-66).** With interception on, the driver would answer a
 *   preflight `OPTIONS` itself, allowing the requesting origin, methods and headers, so a
 *   cross-origin write the site refuses at preflight would be sent (deferred D41). {@link install}
 *   therefore also installs a preflight hook (`driver-preflights.ts`): a paused preflight is shown
 *   to the handlers that declare {@link InterceptionHandler.preflight} (the self-origin guard), then
 *   Chromium sends it to the site and checks the site's answer itself, as it does without a route.
 *   The routed context's preflight cache is off with its HTTP cache, so the chain keeps the site's
 *   answers ({@link PreflightCache}) for their `Access-Control-Max-Age`. The blocklist and the
 *   request guard never see a preflight, only the request Chromium sends after an allowed one.
 *
 * What a route cannot see (spec 13 §3.8), measured on Chromium (Playwright 1.63 and Patchright 1.63):
 * - the hops of a redirect after its first URL (Playwright routes only the first URL of a
 *   redirect chain; 307/308 keep the method, so this covers `POST` too);
 * - requests from a `SharedWorker` (dedicated and service workers are routed);
 * - `navigator.sendBeacon` and `fetch(…, {keepalive: true})` sent while a page closes
 *   (`pagehide`/`unload` during `page.close()`, which `close_tab` and `close_session` do);
 * - WebSocket frames, and requests made from a `javascript:` URL (refused for agents, D-57).
 *
 * A popup's first navigation has no frame and, under the driver, a service worker's requests
 * have none either; that matters to {@link OwnerResolver}, not to matching.
 */

/** A handler's verdict. `abort` ends the chain; `pass` hands the request to the next handler. */
export type InterceptionVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'abort'; readonly reason: 'blockedbyclient' | 'failed' };

/** The `pass` verdict. */
export const PASS: InterceptionVerdict = Object.freeze({ kind: 'pass' });

/** The handler ids, in the order the chain runs them (spec 13 §3.8). */
export const HANDLER_ORDER = ['self-origin', 'blocklist', 'request-guard'] as const;

/** One of {@link HANDLER_ORDER}. */
export type InterceptionHandlerId = (typeof HANDLER_ORDER)[number];

/** Per-request facts the chain resolves lazily, at most once, for the handlers that need them. */
export interface InterceptionContext {
  /** The request's owner (spec 13 §3.8). Memoized per request. */
  owner(): Promise<RequestOwner>;
  /**
   * Aborted when the request goes away while a handler still holds it: Chromium fails it (a
   * superseded navigation), its page closes, or the context closes. For held decisions only.
   */
  signal(): AbortSignal;
}

/**
 * One policy in the chain. A handler decides from the request alone and never calls the route
 * itself: the chain does `fallback` and `abort`, so no handler can end the request twice. A held
 * decision (a `confirm` awaiting an operator) is a handler that has not returned yet.
 */
export interface InterceptionHandler {
  /** Its slot in {@link HANDLER_ORDER}; also logged when the handler throws. */
  readonly id: InterceptionHandlerId;
  /**
   * What an exception from {@link handle} (or a malformed verdict) does. `closed` (a blocking
   * policy): a `document` request is aborted with `failed`, any other request goes on to the next
   * handler. `open` (an observation): the request goes on. A handler that knows a failed request
   * was one it governs returns its own `abort` instead of throwing.
   */
  readonly onError: 'closed' | 'open';
  handle(request: Request, context: InterceptionContext): Promise<InterceptionVerdict>;
  /**
   * Decides on a CORS preflight before Chromium sends it (D-66). Absent: the preflight goes on, and
   * the handler decides on the request Chromium sends after an allowed answer, as before. Only a
   * handler whose rule covers every request to a URL, whatever its method and type, declares it
   * (the self-origin guard: no request of any kind may reach BrowserHive). An `abort` fails the
   * preflight, so the page sees a CORS failure and the request is never sent. An exception fails
   * it too for a `closed` handler, and lets it go on for an `open` one.
   */
  preflight?(preflight: PreflightRequest): Promise<InterceptionVerdict>;
}

export type { PreflightRequest } from './driver-preflights.ts';

/** Resolves a request's owner. Exclusive sessions use {@link fixedOwner}. */
export type OwnerResolver = (request: Request) => Promise<RequestOwner>;

/** The owner resolver of an exclusive session: every request belongs to its one session. */
export function fixedOwner(sessionId: string): OwnerResolver {
  const owner: RequestOwner = Object.freeze({ kind: 'session', sessionId });
  return () => Promise.resolve(owner);
}

/** Collaborators of {@link InterceptionChain}. */
export interface InterceptionChainDeps {
  /** Run in {@link HANDLER_ORDER} whatever the order here; the first `abort` wins. */
  readonly handlers?: readonly InterceptionHandler[];
  readonly resolveOwner: OwnerResolver;
  readonly logger: Logger;
  /** The preflight cache's time source; the system clock when absent. */
  readonly clock?: Pick<Clock, 'now'>;
  /**
   * Arms the preflight hook on the context at {@link InterceptionChain.install}; the driver's
   * (`installPreflightHook`) when absent. Tests of the chain alone pass a fake.
   */
  readonly installPreflights?: (
    context: BrowserContext,
    hook: PreflightHook,
  ) => Result<void, Error>;
}

/** Removes a registered handler. Idempotent. */
export type InterceptionDisposer = () => void;

const SLOT: ReadonlyMap<string, number> = new Map(HANDLER_ORDER.map((id, i) => [id, i]));

const CONTINUE: PreflightVerdict = Object.freeze({ kind: 'continue' });

/** The system time, for a chain built without a clock. */
const SYSTEM_NOW: Pick<Clock, 'now'> = { now: () => Date.now() };

/**
 * Ordered in-process request handlers behind one route. Build one per context: the context's
 * owner (a browser host, PR T1a) keeps it and installers {@link register} their handler on it.
 */
export class InterceptionChain {
  private handlerList: readonly InterceptionHandler[] = [];
  private readonly resolveOwner: OwnerResolver;
  private readonly log: Logger;
  private installedOn: BrowserContext | null = null;
  /**
   * Held requests that asked for a signal, so a failed request, a closed page or a closed context
   * aborts it; `release` drops the page listener when the request settles.
   */
  private readonly held = new Map<Request, { controller: AbortController; release: () => void }>();
  private isListening = false;
  private readonly installPreflights: NonNullable<InterceptionChainDeps['installPreflights']>;
  private readonly preflightCache: PreflightCache;
  private preflightsReal = false;

  constructor(deps: InterceptionChainDeps) {
    this.resolveOwner = deps.resolveOwner;
    this.log = deps.logger.child({ module: 'interception' });
    this.installPreflights = deps.installPreflights ?? installPreflightHook;
    const clock = deps.clock ?? SYSTEM_NOW;
    this.preflightCache = new PreflightCache({ now: () => clock.now() });
    for (const handler of deps.handlers ?? []) {
      const added = this.register(handler);
      if (!added.ok) throw added.error;
    }
  }

  /**
   * Whether the context's CORS preflights are sent by Chromium and checked against the site's
   * answer (D-66). `false` before {@link install}, or when the driver's internals were not as
   * expected: the driver then answers them itself (logged as an error).
   */
  get preflightsEnforced(): boolean {
    return this.preflightsReal;
  }

  /** The site's preflight answers this chain replays (tests). */
  get preflights(): PreflightCache {
    return this.preflightCache;
  }

  /** The handlers in force, in run order. */
  get handlers(): readonly InterceptionHandler[] {
    return this.handlerList;
  }

  /**
   * Add `handler` in its slot. One handler per id: a second one is refused, since two blocklists
   * or two guards on one context would each decide on their own rules. Takes effect on the next
   * request; the returned disposer removes exactly this handler.
   */
  register(handler: InterceptionHandler): Result<InterceptionDisposer, Error> {
    if (!SLOT.has(handler.id)) return err(new Error('unknown interception handler id'));
    if (this.handlerList.some((h) => h.id === handler.id)) {
      return err(new Error('interception handler already registered'));
    }
    this.handlerList = [...this.handlerList, handler].sort(
      (a, b) => (SLOT.get(a.id) ?? 0) - (SLOT.get(b.id) ?? 0),
    );
    return ok(() => {
      this.handlerList = this.handlerList.filter((h) => h !== handler);
    });
  }

  /**
   * Install the one route on `context`, before anything navigates. Idempotent for the same
   * context; a different context is refused (a chain serves one context, and two routes on one
   * context would run in reverse order).
   */
  async install(context: BrowserContext): Promise<Result<void, unknown>> {
    if (this.installedOn === context) return ok(undefined);
    if (this.installedOn !== null)
      return err(new Error('interception chain serves another context'));
    // The hook first: once the route is on, the driver would answer any preflight not handed to it.
    this.armPreflights(context);
    try {
      await context.route('**/*', (route: Route) => this.handle(route));
      this.installedOn = context;
      return ok(undefined);
    } catch (error) {
      return err(error);
    }
  }

  /**
   * Hands the context's preflights to {@link handlePreflight} (D-66). A failure is logged, not
   * returned: the route still stands, and the driver keeps answering preflights as it did before.
   */
  private armPreflights(context: BrowserContext): void {
    const unavailable = (error: unknown): void => {
      this.preflightsReal = false;
      this.log.error('preflight hook unavailable', { err: serializeError(error) });
    };
    try {
      const armed = this.installPreflights(context, {
        decide: (preflight) => this.handlePreflight(preflight),
        cache: this.preflightCache,
        unavailable,
      });
      if (armed.ok) this.preflightsReal = true;
      else unavailable(armed.error);
    } catch (error) {
      unavailable(error);
    }
  }

  /**
   * Runs the handlers that declare {@link InterceptionHandler.preflight} over a CORS preflight, in
   * {@link HANDLER_ORDER}; the first `abort` fails it. Never throws.
   */
  async handlePreflight(preflight: PreflightRequest): Promise<PreflightVerdict> {
    for (const handler of this.handlerList) {
      if (handler.preflight === undefined) continue;
      let verdict: InterceptionVerdict;
      try {
        verdict = checkedVerdict(await handler.preflight(preflight));
      } catch (error) {
        this.log.error('interception handler threw', {
          handler: handler.id,
          preflight: true,
          err: serializeError(error),
        });
        if (handler.onError === 'closed') return { kind: 'abort', reason: 'failed' };
        continue;
      }
      if (verdict.kind === 'abort') return verdict;
    }
    return CONTINUE;
  }

  /** Run the handlers over one routed request, then pass it on or abort it. Never throws. */
  async handle(route: Route): Promise<void> {
    let request: Request;
    try {
      request = route.request();
    } catch (error) {
      // No request to decide on (the page went away mid-flight): let Playwright handle the route.
      this.log.debug('routed request unreadable', { err: serializeError(error) });
      return await this.fallback(route);
    }
    const context = this.contextFor(request);
    try {
      for (const handler of this.handlerList) {
        let verdict: InterceptionVerdict;
        try {
          verdict = checkedVerdict(await handler.handle(request, context));
        } catch (error) {
          this.log.error('interception handler threw', {
            handler: handler.id,
            err: serializeError(error),
          });
          if (handler.onError === 'closed' && isDocument(request)) {
            return await this.abort(route, 'failed');
          }
          continue;
        }
        if (verdict.kind === 'abort') return await this.abort(route, verdict.reason);
      }
      await this.fallback(route);
    } finally {
      this.held.get(request)?.release();
      this.held.delete(request);
    }
  }

  private contextFor(request: Request): InterceptionContext {
    let owner: Promise<RequestOwner> | null = null;
    return {
      owner: () => {
        owner ??= this.resolveOwner(request);
        return owner;
      },
      signal: () => {
        const existing = this.held.get(request);
        if (existing !== undefined) return existing.controller.signal;
        const controller = new AbortController();
        this.held.set(request, { controller, release: this.onPageClose(request, controller) });
        this.listen();
        return controller.signal;
      },
    };
  }

  /**
   * Aborts `controller` when the request's page closes. Chromium does not report a paused
   * (routed) request as failed when its page closes, so the page is watched directly. A request
   * without a frame (a popup's first navigation, a service worker's) relies on the context.
   */
  private onPageClose(request: Request, controller: AbortController): () => void {
    try {
      const page = request.frame().page();
      const abort = () => controller.abort();
      page.once('close', abort);
      return () => page.off('close', abort);
    } catch (error) {
      this.log.debug('held request has no page', { err: serializeError(error) });
      return () => undefined;
    }
  }

  /** Subscribes, once and only when a handler first holds a request, to the context's events. */
  private listen(): void {
    const context = this.installedOn;
    if (this.isListening || context === null) return;
    this.isListening = true;
    context.on('requestfailed', (request) => this.held.get(request)?.controller.abort());
    context.on('close', () => {
      for (const { controller } of this.held.values()) controller.abort();
    });
  }

  /** `route.fallback()`: the next route handler, then Playwright's default (the network). */
  private async fallback(route: Route): Promise<void> {
    try {
      await route.fallback();
    } catch (error) {
      // The page navigated away mid-flight — the request is already moot.
      this.log.debug('route fallback failed', { err: serializeError(error) });
    }
  }

  private async abort(route: Route, reason: 'blockedbyclient' | 'failed'): Promise<void> {
    try {
      await route.abort(reason);
    } catch (error) {
      // Already handled or gone.
      this.log.debug('route abort failed', { err: serializeError(error) });
    }
  }
}

/**
 * A verdict as the types promise it. A handler that returns anything else (an action it does not
 * know, a missing return) is treated as one that threw, so the route is never left unresolved.
 */
function checkedVerdict(verdict: unknown): InterceptionVerdict {
  if (typeof verdict === 'object' && verdict !== null && 'kind' in verdict) {
    if (verdict.kind === 'pass') return PASS;
    if (verdict.kind === 'abort' && 'reason' in verdict) {
      if (verdict.reason === 'blockedbyclient' || verdict.reason === 'failed') {
        return { kind: 'abort', reason: verdict.reason };
      }
    }
  }
  throw new Error('interception handler returned no verdict');
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

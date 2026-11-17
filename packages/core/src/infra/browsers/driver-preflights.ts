/** @module infra/browsers/driver-preflights — real CORS preflights in routed contexts: the driver's intercepted `OPTIONS` preflight is handed to the context's interception chain and then to the network (or the site's cached answer) instead of being answered by the driver (D-66, deferred D41). */

import type { BrowserContext } from 'patchright';
import { err, ok, type Result } from '../../kernel/result.ts';
import { type PreflightCache, preflightKey } from './preflight-cache.ts';

/**
 * The problem (measured on Patchright 1.63, `coreBundle.js` `CRNetworkManager._onRequest`, the same
 * code as `playwright-core` `crNetworkManager.ts`). The driver enables CDP `Fetch` with
 * `{urlPattern: '*', requestStage: 'Request'}` on every page session, whatever URL the route names,
 * so Chromium pauses the CORS preflight of every non-simple cross-origin request. When the page has
 * any route (`needsRequestInterception()`), the driver answers that paused `OPTIONS` itself with
 * `204`, `Access-Control-Allow-Origin: <Origin>`, `-Methods: <the asked method>`, `-Headers: <the
 * asked headers>` and `-Credentials: true`, and never shows it to the route; without a route it
 * continues it to the network. So under BrowserHive's route a write the site refuses at preflight
 * was sent. A `Fetch` pattern cannot leave preflights out: the paused preflight carries the
 * resource type of the request it precedes (`XHR`, `Fetch`), not `Preflight`.
 *
 * The fix. `_onRequest` is wrapped once per process, on the class's prototype. For a context with
 * a registered {@link PreflightHook}, an intercepted preflight is decided by the hook (the chain's
 * preflight-aware handlers: the self-origin guard) and then continued to the network, so Chromium
 * itself sends it (without credentials, through the context's proxy, with its own network stack
 * and TLS) and runs its own CORS check on the site's answer, exactly as without a route. Every other
 * request, and every preflight of a context without a hook, goes to the driver's code unchanged.
 * Chromium bypasses its preflight cache in a routed context (the HTTP cache is off), so the site's
 * answers are kept in the hook's {@link PreflightCache} and replayed for the same question while
 * their `Access-Control-Max-Age` lasts.
 *
 * Driver internals read (re-check on every Patchright bump; pinned by
 * `test/integration/cors-preflights.test.ts`): `BrowserContext._connection.toImpl` (the in-process
 * connection's client-to-server lookup), the server `Page.delegate._networkManager`,
 * `CRNetworkManager.prototype._onRequest(requestWillBeSentSessionInfo, requestWillBeSentEvent,
 * requestPausedSessionInfo, requestPausedEvent)`, its `_page`/`_serviceWorker`/
 * `_alreadyTrackedNetworkIds`, and `CRSession._sendMayFail`/`on`. When one is missing the hook is
 * not installed and the driver keeps answering preflights (the caller logs it).
 */

/** A CORS preflight about to be sent, as the chain's handlers see it. */
export interface PreflightRequest {
  /** The URL of the preflight, which is the URL of the request it asks for. */
  readonly url: string;
  /** `Origin`: the origin asking. */
  readonly origin: string | null;
  /** `Access-Control-Request-Method`: the method of the request waiting for the answer. */
  readonly requestMethod: string | null;
  /** `Access-Control-Request-Headers`: its non-safelisted header names. */
  readonly requestHeaders: string | null;
}

/** What happens to a preflight: it goes on (to the site, or its cached answer), or it is failed. */
export type PreflightVerdict =
  | { readonly kind: 'continue' }
  | { readonly kind: 'abort'; readonly reason: 'blockedbyclient' | 'failed' };

/** One context's preflight policy and cache. */
export interface PreflightHook {
  /** Decides on a preflight; a rejection fails it (`failed`). */
  decide(preflight: PreflightRequest): Promise<PreflightVerdict>;
  readonly cache: PreflightCache;
  /** Called when the hook could only be armed for a later first page and that page's driver internals were not as expected. */
  unavailable?(error: Error): void;
}

const PATCHED = Symbol.for('browserhive.realPreflights');

/** Server-side browser contexts with a hook. Weak: a closed context's hook goes with it. */
const hooks = new WeakMap<object, PreflightHook>();

/** Questions sent to the network whose answer is awaited, per hook (request id → cache key). */
const pendingOf = new WeakMap<PreflightHook, Map<string, { key: string; origin: string }>>();

/** CDP sessions whose responses a hook already listens to. */
const watchedOf = new WeakMap<PreflightHook, WeakSet<object>>();

/** At most this many questions await an answer per hook (a session that dies leaves none behind). */
const PENDING_LIMIT = 256;

type Fn = (...args: unknown[]) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `value[key]` when `value` is an object. */
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** A CDP session of the driver: `_sendMayFail` (never rejects) and event subscription. */
interface DriverSession {
  _sendMayFail(method: string, params: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (event: unknown) => void): unknown;
}

function isDriverSession(value: unknown): value is DriverSession {
  return (
    typeof field(value, '_sendMayFail') === 'function' && typeof field(value, 'on') === 'function'
  );
}

/** A string-valued header map (CDP's `Headers`); anything else is dropped. */
function headerMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [name, v] of Object.entries(value)) if (typeof v === 'string') out[name] = v;
  return out;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

/** The server-side object of a client-side driver object, through the in-process connection. */
function serverObjectOf(client: object): object | null {
  try {
    const toImpl = field(field(client, '_connection'), 'toImpl');
    if (typeof toImpl !== 'function') return null;
    const impl: unknown = Reflect.apply(toImpl, field(client, '_connection'), [client]);
    return isRecord(impl) ? impl : null;
  } catch {
    // Not an in-process driver connection.
    return null;
  }
}

/**
 * Wraps `CRNetworkManager.prototype._onRequest`, found through a server page; once per process.
 *
 * @returns Whether the prototype is (now) wrapped.
 */
function patchFrom(serverPage: unknown): boolean {
  const manager = field(field(serverPage, 'delegate'), '_networkManager');
  if (!isRecord(manager)) return false;
  const proto: unknown = Object.getPrototypeOf(manager);
  if (!isRecord(proto)) return false;
  if (Reflect.get(proto, PATCHED) === true) return true;
  const original = proto['_onRequest'];
  if (typeof original !== 'function' || original.length !== 4) return false;
  if (!(field(manager, '_alreadyTrackedNetworkIds') instanceof Set)) return false;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    if (takeOver(this, args)) return undefined;
    return Reflect.apply(original as Fn, this, args);
  };
  Object.defineProperty(proto, '_onRequest', {
    value: wrapped,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(proto, PATCHED, { value: true });
  return true;
}

/**
 * Takes an intercepted preflight away from the driver when its context has a hook.
 *
 * @returns `false` (the driver handles it) for anything else, or when a shape is not as expected.
 */
function takeOver(manager: unknown, args: readonly unknown[]): boolean {
  try {
    const [sentInfo, sent, pausedInfo, paused] = args;
    if (paused === undefined || paused === null) return false;
    const request = field(paused, 'request');
    if (field(request, 'method') !== 'OPTIONS') return false;
    if (field(field(sent, 'initiator'), 'type') !== 'preflight') return false;
    const owner = field(manager, '_page') ?? field(manager, '_serviceWorker');
    const context = field(owner, 'browserContext');
    if (!isRecord(context)) return false;
    const hook = hooks.get(context);
    if (hook === undefined) return false;
    const sentId = field(sent, 'requestId');
    const tracked = field(manager, '_alreadyTrackedNetworkIds');
    if (typeof sentId !== 'string' || (tracked instanceof Set && tracked.has(sentId))) return false;
    const pausedSession = field(pausedInfo, 'session');
    const sentSession = field(sentInfo, 'session');
    const pausedId = field(paused, 'requestId');
    const url = field(request, 'url');
    if (!isDriverSession(pausedSession) || !isDriverSession(sentSession)) return false;
    if (typeof pausedId !== 'string' || typeof url !== 'string') return false;
    handle(hook, {
      url,
      headers: headerMap(field(request, 'headers')),
      topOrigin: topOriginOf(field(manager, '_page')),
      pausedSession,
      pausedId,
      sentSession,
      sentId,
    }).catch(() =>
      // Never leave a preflight paused: fail it (closed), as a throwing decision does.
      pausedSession._sendMayFail('Fetch.failRequest', {
        requestId: pausedId,
        errorReason: FAIL_REASON.failed,
      }),
    );
    return true;
  } catch {
    // An unexpected shape: the driver's own code handles the request.
    return false;
  }
}

/** The origin of the page's top frame; `''` for a service worker or a page without one. */
function topOriginOf(page: unknown): string {
  try {
    const mainFrame = field(page, 'mainFrame');
    if (typeof mainFrame !== 'function') return '';
    const frame: unknown = Reflect.apply(mainFrame, page, []);
    const url = field(frame, 'url');
    const href: unknown = typeof url === 'function' ? Reflect.apply(url, frame, []) : null;
    return typeof href === 'string' ? new URL(href).origin : '';
  } catch {
    // No frame, or a URL that does not parse.
    return '';
  }
}

interface PausedPreflight {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly topOrigin: string;
  readonly pausedSession: DriverSession;
  readonly pausedId: string;
  readonly sentSession: DriverSession;
  readonly sentId: string;
}

const FAIL_REASON = { blockedbyclient: 'BlockedByClient', failed: 'Failed' } as const;

async function handle(hook: PreflightHook, preflight: PausedPreflight): Promise<void> {
  const { headers, pausedSession, pausedId } = preflight;
  let verdict: PreflightVerdict;
  try {
    verdict = await hook.decide({
      url: preflight.url,
      origin: header(headers, 'origin'),
      requestMethod: header(headers, 'access-control-request-method'),
      requestHeaders: header(headers, 'access-control-request-headers'),
    });
  } catch {
    verdict = { kind: 'abort', reason: 'failed' };
  }
  if (verdict.kind === 'abort') {
    await pausedSession._sendMayFail('Fetch.failRequest', {
      requestId: pausedId,
      errorReason: FAIL_REASON[verdict.reason],
    });
    return;
  }
  const key = preflightKey({ url: preflight.url, topOrigin: preflight.topOrigin, headers });
  const cached = hook.cache.get(key);
  if (cached !== null) {
    await pausedSession._sendMayFail('Fetch.fulfillRequest', {
      requestId: pausedId,
      responseCode: cached.status,
      responseHeaders: cached.headers,
      body: '',
    });
    return;
  }
  awaitAnswer(hook, preflight.sentSession, preflight.sentId, key, header(headers, 'origin') ?? '');
  await pausedSession._sendMayFail('Fetch.continueRequest', { requestId: pausedId });
}

/** Records the site's answer to the preflight `requestId` in the hook's cache when it arrives. */
function awaitAnswer(
  hook: PreflightHook,
  session: DriverSession,
  requestId: string,
  key: string,
  origin: string,
): void {
  let pending = pendingOf.get(hook);
  if (pending === undefined) {
    pending = new Map();
    pendingOf.set(hook, pending);
  }
  pending.set(requestId, { key, origin });
  while (pending.size > PENDING_LIMIT) {
    const oldest = pending.keys().next();
    if (oldest.done === true) break;
    pending.delete(oldest.value);
  }
  let watched = watchedOf.get(hook);
  if (watched === undefined) {
    watched = new WeakSet();
    watchedOf.set(hook, watched);
  }
  if (watched.has(session)) return;
  watched.add(session);
  const waiting = pending;
  session.on('Network.responseReceived', (event) => {
    const id = field(event, 'requestId');
    if (typeof id !== 'string') return;
    const question = waiting.get(id);
    if (question === undefined) return;
    waiting.delete(id);
    const response = field(event, 'response');
    const status = field(response, 'status');
    if (typeof status !== 'number') return;
    hook.cache.store(question.key, question.origin, status, headerMap(field(response, 'headers')));
  });
  session.on('Network.loadingFailed', (event) => {
    const id = field(event, 'requestId');
    if (typeof id === 'string') waiting.delete(id);
  });
}

/**
 * Hands the intercepted preflights of `context` to `hook` from now on (see the module doc).
 * Idempotent per context: a second hook replaces the first.
 *
 * @returns An error when the driver's internals are not as expected; the driver then keeps
 *   answering preflights itself.
 */
export function installPreflightHook(
  context: BrowserContext,
  hook: PreflightHook,
): Result<void, Error> {
  const server = serverObjectOf(context);
  if (server === null) return err(new Error('no in-process driver connection'));
  const pages = field(server, 'pages');
  if (typeof pages !== 'function' || typeof field(server, 'on') !== 'function') {
    return err(new Error('unexpected driver browser context'));
  }
  const existing: unknown = Reflect.apply(pages, server, []);
  if (!Array.isArray(existing)) return err(new Error('unexpected driver browser context'));
  if (existing.length > 0) {
    if (!patchFrom(existing[0])) return err(new Error('unexpected driver network manager'));
  } else {
    // No page yet: wrap on the first one, which the server reports before its target resumes,
    // so before it can load anything.
    const on = field(server, 'on') as Fn;
    const off = field(server, 'off');
    const onPage = (page: unknown): void => {
      if (!patchFrom(page)) hook.unavailable?.(new Error('unexpected driver network manager'));
      if (typeof off === 'function') Reflect.apply(off, server, ['page', onPage]);
    };
    Reflect.apply(on, server, ['page', onPage]);
  }
  hooks.set(server, hook);
  return ok(undefined);
}

/** Whether `context` has a hook (tests). */
export function hasPreflightHook(context: BrowserContext): boolean {
  const server = serverObjectOf(context);
  return server !== null && hooks.has(server);
}

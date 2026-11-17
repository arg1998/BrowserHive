/** @module infra/browsers/driver-preflights — real CORS preflights in routed contexts: the driver's intercepted `OPTIONS` preflight is handed to the context's interception chain and then to the network (or the site's cached answer) instead of being answered by the driver (D-66, deferred D41). */

import type { BrowserContext } from 'patchright';
import { err, ok, type Result } from '../../kernel/result.ts';
import {
  driverCoreVersion,
  isVerifiedDriverVersion,
  markPreflightsEnforced,
  type PreflightRefusal,
  refusePreflights,
  sharedPreflightState,
} from './preflight-enforcement.ts';
import {
  FAIL_REASON,
  field,
  headerMap,
  isDriverSession,
  isRecord,
  type PreflightHook,
  relayPreflight,
} from './preflight-relay.ts';

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
 * `_alreadyTrackedNetworkIds`, and `CRSession._sendMayFail`/`on`.
 *
 * Fail closed (review F1). The hook is armed only for a `patchright-core` version in
 * `VERIFIED_DRIVER_VERSIONS` whose `_onRequest` source still holds the preflight branch it replaces
 * ({@link PREFLIGHT_BRANCH_MARKERS}). Anything else refuses enforcement for the process
 * (`preflight-enforcement.ts`): the interception chain then refuses cross-origin requests that
 * need a preflight (the driver would have answered it), and the refusal is reported as the
 * `PREFLIGHTS_NOT_ENFORCED` degradation, on `/system` and by `doctor`. Once a paused request is
 * known to be a preflight of a hooked context, a shape the hook cannot read fails it
 * (`Fetch.failRequest`) and refuses enforcement; it is never handed back to the driver.
 *
 * Monkey-patching a third-party prototype is the exception spec 05 allows here (D-66): the
 * published package cannot patch its dependency at install time, and the driver has no API for it.
 */

export type { PreflightHook, PreflightRequest, PreflightVerdict } from './preflight-relay.ts';

/** Marks a wrapped `CRNetworkManager` prototype (per prototype, so a second driver copy is wrapped too). */
const PATCHED = Symbol.for('browserhive.realPreflights');

/**
 * What the verified `_onRequest` source contains: the preflight test, the `OPTIONS` method, the
 * route check and both answers it chooses between. A driver whose `_onRequest` lacks one of them
 * handles preflights elsewhere, so wrapping it would enforce nothing while reporting it does.
 */
export const PREFLIGHT_BRANCH_MARKERS: readonly string[] = Object.freeze([
  '"preflight"',
  '"OPTIONS"',
  'needsRequestInterception',
  'Fetch.fulfillRequest',
  'Fetch.continueRequest',
]);

/** Whether `fn` is the verified `_onRequest`: four parameters and every marker in its source. */
export function isVerifiedOnRequest(fn: unknown): boolean {
  if (typeof fn !== 'function' || fn.length !== 4) return false;
  let source: string;
  try {
    source = Function.prototype.toString.call(fn);
  } catch {
    return false;
  }
  return PREFLIGHT_BRANCH_MARKERS.every((marker) => source.includes(marker));
}

/** The hook of a server-side context, from the registry every module copy shares. */
function hookOf(context: object): PreflightHook | undefined {
  const hook = sharedPreflightState().hooks.get(context);
  return isHook(hook) ? hook : undefined;
}

function isHook(value: unknown): value is PreflightHook {
  return typeof field(value, 'decide') === 'function' && isRecord(field(value, 'cache'));
}

type Fn = (...args: unknown[]) => unknown;

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
 * Wraps `CRNetworkManager.prototype._onRequest`, found through a server page; once per prototype.
 * Refuses enforcement for the process when the driver is not the verified one.
 *
 * @returns Whether the prototype is (now) wrapped.
 */
function patchFrom(serverPage: unknown): boolean {
  const refuse = (reason: PreflightRefusal): boolean => {
    refusePreflights(reason);
    return false;
  };
  if (!isVerifiedDriverVersion(driverCoreVersion())) return refuse('driver_version');
  const manager = field(field(serverPage, 'delegate'), '_networkManager');
  if (!isRecord(manager)) return refuse('driver_shape');
  const proto: unknown = Object.getPrototypeOf(manager);
  if (!isRecord(proto)) return refuse('driver_shape');
  if (Reflect.get(proto, PATCHED) === true) {
    markPreflightsEnforced();
    return true;
  }
  const original = proto['_onRequest'];
  if (!isVerifiedOnRequest(original)) return refuse('driver_shape');
  if (!(field(manager, '_alreadyTrackedNetworkIds') instanceof Set)) return refuse('driver_shape');
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
  markPreflightsEnforced();
  return true;
}

/**
 * Takes an intercepted preflight away from the driver when its context has a hook.
 *
 * @returns `false` (the driver handles it) for anything that is not a preflight of a hooked
 *   context. A preflight of a hooked context is never handed back: when its shape cannot be read,
 *   it is failed and enforcement is refused (fail closed).
 */
export function takeOver(manager: unknown, args: readonly unknown[]): boolean {
  let paused: unknown;
  let pausedInfo: unknown;
  try {
    const [sentInfo, sent, pausedInfoArg, pausedArg] = args;
    paused = pausedArg;
    pausedInfo = pausedInfoArg;
    if (paused === undefined || paused === null) return false;
    const request = field(paused, 'request');
    if (field(request, 'method') !== 'OPTIONS') return false;
    if (field(field(sent, 'initiator'), 'type') !== 'preflight') return false;
    const owner = field(manager, '_page') ?? field(manager, '_serviceWorker');
    const context = field(owner, 'browserContext');
    if (!isRecord(context)) return false;
    const hook = hookOf(context);
    if (hook === undefined) return false;
    // From here on the request is a preflight of a hooked context.
    const sentId = field(sent, 'requestId');
    const tracked = field(manager, '_alreadyTrackedNetworkIds');
    // The driver's own early return (a request it already tracks): nothing to answer.
    if (typeof sentId === 'string' && tracked instanceof Set && tracked.has(sentId)) return false;
    const pausedSession = field(pausedInfo, 'session');
    const sentSession = field(sentInfo, 'session');
    const pausedId = field(paused, 'requestId');
    const url = field(request, 'url');
    if (
      typeof sentId !== 'string' ||
      !isDriverSession(pausedSession) ||
      !isDriverSession(sentSession) ||
      typeof pausedId !== 'string' ||
      typeof url !== 'string'
    ) {
      return failUnexpected(pausedInfo, paused);
    }
    relayPreflight(hook, {
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
    return failUnexpected(pausedInfo, paused);
  }
}

/**
 * A preflight of a hooked context the hook cannot read: fail it when its session allows, and
 * refuse enforcement so the chain fails closed for what the driver would answer.
 *
 * @returns Whether the request was failed here (else the driver gets it, and the chain refuses
 *   the request that follows).
 */
function failUnexpected(pausedInfo: unknown, paused: unknown): boolean {
  refusePreflights('unexpected_preflight');
  const session = field(pausedInfo, 'session');
  const requestId = field(paused, 'requestId');
  if (!isDriverSession(session) || typeof requestId !== 'string') return false;
  void session._sendMayFail('Fetch.failRequest', { requestId, errorReason: FAIL_REASON.failed });
  return true;
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

/**
 * Hands the intercepted preflights of `context` to `hook` from now on (see the module doc).
 * Idempotent per context: a second hook replaces the first.
 *
 * @returns `armed` when the driver's preflight code is wrapped; `pending` when the context has no
 *   page yet (the code is wrapped when its first page appears; until then the chain fails closed);
 *   an error when enforcement is refused (the driver is not the verified one).
 */
export function installPreflightHook(
  context: BrowserContext,
  hook: PreflightHook,
): Result<'armed' | 'pending', Error> {
  const refused = (reason: PreflightRefusal): Result<'armed' | 'pending', Error> => {
    refusePreflights(reason);
    return err(new Error(`cors preflights not enforced: ${reason}`));
  };
  if (!isVerifiedDriverVersion(driverCoreVersion())) return refused('driver_version');
  const server = serverObjectOf(context);
  // Not a driver context (only a test's fake): this chain fails closed, the process is not refused.
  if (server === null) return err(new Error('cors preflights not enforced: driver_connection'));
  const pages = field(server, 'pages');
  const on = field(server, 'on');
  if (typeof pages !== 'function' || typeof on !== 'function') return refused('driver_shape');
  const existing: unknown = Reflect.apply(pages, server, []);
  if (!Array.isArray(existing)) return refused('driver_shape');
  sharedPreflightState().hooks.set(server, hook);
  if (existing.length > 0) {
    return patchFrom(existing[0]) ? ok('armed') : refused('driver_shape');
  }
  // No page yet. The server reports a page after its target has resumed and committed its first
  // navigation (Patchright 1.63 `CRPage` → `_initialize` → `reportAsNew`), so a first page opened
  // with a URL could send a preflight before this wraps the driver; the chain refuses such
  // requests while the state is `pending` (fail closed). BrowserHive opens every first page blank.
  const off = field(server, 'off');
  const onPage = (page: unknown): void => {
    patchFrom(page);
    if (typeof off === 'function') Reflect.apply(off, server, ['page', onPage]);
  };
  Reflect.apply(on, server, ['page', onPage]);
  return ok('pending');
}

/** Whether `context` has a hook (tests). */
export function hasPreflightHook(context: BrowserContext): boolean {
  const server = serverObjectOf(context);
  return server !== null && hookOf(server) !== undefined;
}

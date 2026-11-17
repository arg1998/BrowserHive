/** @module infra/browsers/preflight-relay — what happens to a preflight taken from the driver (D-66): the chain's decision, then `Fetch.failRequest`, a replay of the site's cached answer, or `Fetch.continueRequest` with the site's answer recorded; plus the guarded readers of driver objects. */

import { type PreflightAsked, type PreflightCache, preflightKey } from './preflight-cache.ts';

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
}

/** Questions sent to the network whose answer is awaited, per hook (request id → cache key). */
const pendingOf = new WeakMap<PreflightHook, Map<string, { key: string; asked: PreflightAsked }>>();

/** CDP sessions whose responses a hook already listens to. */
const watchedOf = new WeakMap<PreflightHook, WeakSet<object>>();

/** At most this many questions await an answer per hook (a session that dies leaves none behind). */
const PENDING_LIMIT = 256;

/** Whether `value` is a non-null object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `value[key]` when `value` is an object. */
export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** A CDP session of the driver: `_sendMayFail` (never rejects) and event subscription. */
export interface DriverSession {
  _sendMayFail(method: string, params: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (event: unknown) => void): unknown;
}

export function isDriverSession(value: unknown): value is DriverSession {
  return (
    typeof field(value, '_sendMayFail') === 'function' && typeof field(value, 'on') === 'function'
  );
}

/** A string-valued header map (CDP's `Headers`); anything else is dropped. */
export function headerMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [name, v] of Object.entries(value)) if (typeof v === 'string') out[name] = v;
  return out;
}

export function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

export interface PausedPreflight {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly topOrigin: string;
  readonly pausedSession: DriverSession;
  readonly pausedId: string;
  readonly sentSession: DriverSession;
  readonly sentId: string;
}

export const FAIL_REASON = { blockedbyclient: 'BlockedByClient', failed: 'Failed' } as const;

export async function relayPreflight(
  hook: PreflightHook,
  preflight: PausedPreflight,
): Promise<void> {
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
  awaitAnswer(hook, preflight.sentSession, preflight.sentId, key, {
    origin: header(headers, 'origin') ?? '',
    method: header(headers, 'access-control-request-method') ?? '',
    headers: header(headers, 'access-control-request-headers') ?? '',
  });
  await pausedSession._sendMayFail('Fetch.continueRequest', { requestId: pausedId });
}

/** Records the site's answer to the preflight `requestId` in the hook's cache when it arrives. */
function awaitAnswer(
  hook: PreflightHook,
  session: DriverSession,
  requestId: string,
  key: string,
  asked: PreflightAsked,
): void {
  let pending = pendingOf.get(hook);
  if (pending === undefined) {
    pending = new Map();
    pendingOf.set(hook, pending);
  }
  pending.set(requestId, { key, asked });
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
    hook.cache.store(question.key, question.asked, status, headerMap(field(response, 'headers')));
  });
  session.on('Network.loadingFailed', (event) => {
    const id = field(event, 'requestId');
    if (typeof id === 'string') waiting.delete(id);
  });
}

/** @module lib/daemon-help/probe — one `/health` probe and what it says about the daemon (04 §18.6.1): shared by the offline page and the running dashboard's reachability watcher (§18.7). Relative imports only and no DOM global at module top level, so the offline build and the root test project can load it. */
import { browserTimers, type Timers } from '../clock.ts';

/** The header every daemon response carries (03 §2); lower case, as `Headers` reports it. */
export const MARKER_HEADER = 'x-browserhive-version';

/** The probed path (same origin). */
export const HEALTH_PATH = '/health';

/** How long a probe waits for the headers and the body before it counts as `timeout`. */
export const PROBE_TIMEOUT_MS = 5_000;

/** The part of `fetch` the probe needs (Bun's `typeof fetch` carries extra statics). */
export type ProbeFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Options of {@link probeHealth}; every member is injectable for tests. */
export interface ProbeOptions {
  /** Defaults to the global `fetch`, read at call time. */
  readonly fetch?: ProbeFetch;
  /** Defaults to `browserTimers` (lib/clock). */
  readonly timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  /** Defaults to {@link PROBE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * The raw result of one probe, before any interpretation.
 * - `rejected`: the request failed (nothing listening, DNS, TLS, CORS after a cross-origin redirect).
 * - `timeout`: neither the response nor its body arrived within the timeout.
 * - `response`: an HTTP answer. `marked` is true when it carries {@link MARKER_HEADER}; `body` is
 *   the parsed JSON body, or `undefined` when the body is not JSON or could not be read.
 */
export type ProbeOutcome =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'timeout' }
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly marked: boolean;
      readonly body: unknown;
    };

/**
 * What a probe says about the daemon (the states of 04 §18.6.1, `checking` aside: that is the
 * UI state before the first probe returns, never a probe result).
 */
export type ProbeState =
  | 'not-running'
  | 'device-offline'
  | 'not-responding'
  | 'ready'
  | 'starting'
  | 'refused'
  | 'proxy-unreachable'
  | 'foreign';

/** Every UI state of the offline page and the banner: the probe states plus `checking`. */
export type DaemonState = 'checking' | ProbeState;

/** The members of a `/health` body that identify BrowserHive (`HealthResponse`, contracts). */
export interface BrowserHiveHealth {
  readonly status: 'starting' | 'ready' | 'degraded' | 'stopping';
  readonly version: string;
}

const HEALTH_STATUSES: ReadonlySet<string> = new Set(['starting', 'ready', 'degraded', 'stopping']);

/**
 * True for a BrowserHive `/health` body: a JSON object whose `status` is one of
 * `starting|ready|degraded|stopping` and whose `version` is a string. Hand-written, not zod, so
 * the offline build stays small; other members (`instance_id`, `checks`, …) are not required.
 */
export function isBrowserHiveHealth(body: unknown): body is BrowserHiveHealth {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const status: unknown = Reflect.get(body, 'status');
  const version: unknown = Reflect.get(body, 'version');
  return typeof status === 'string' && HEALTH_STATUSES.has(status) && typeof version === 'string';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

/**
 * Probes `GET /health` once: `fetch('/health', { cache: 'no-store' })`, aborted after the timeout.
 * Never rejects. The timer is cleared as soon as the probe settles.
 */
export function probeHealth(options: ProbeOptions = {}): Promise<ProbeOutcome> {
  const fetchImpl: ProbeFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timers = options.timers ?? browserTimers;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  return new Promise((resolve) => {
    let settled = false;
    const timer = timers.setTimeout(() => {
      finish({ kind: 'timeout' });
      controller?.abort();
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
    function finish(outcome: ProbeOutcome): void {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      resolve(outcome);
    }
    const init: RequestInit = {
      cache: 'no-store',
      ...(controller !== null && { signal: controller.signal }),
    };
    void (async () => {
      let response: Response;
      try {
        response = await fetchImpl(HEALTH_PATH, init);
      } catch {
        finish({ kind: 'rejected' });
        return;
      }
      const marked = response.headers.has(MARKER_HEADER);
      const body = await readJson(response);
      finish({ kind: 'response', status: response.status, marked, body });
    })();
  });
}

/**
 * True when the outcome proves the daemon is reachable: any response carrying the marker, healthy
 * or not. Rejections, timeouts and unmarked responses (a proxy, another program) are not.
 */
export function isDaemonAnswer(outcome: ProbeOutcome): boolean {
  return outcome.kind === 'response' && outcome.marked;
}

/** What the environment says, passed in so {@link classifyProbe} stays pure. */
export interface ProbeContext {
  /** `navigator.onLine`; only `false` changes anything (a rejection becomes `device-offline`). */
  readonly online: boolean;
}

/**
 * Classifies one probe outcome (04 §18.6.1, pure). A BrowserHive body decides on its own, marked
 * or not, so a daemon older than the marker still reloads the page when it is ready.
 */
export function classifyProbe(outcome: ProbeOutcome, context: ProbeContext): ProbeState {
  if (outcome.kind === 'rejected') return context.online ? 'not-running' : 'device-offline';
  if (outcome.kind === 'timeout') return 'not-responding';
  if (isBrowserHiveHealth(outcome.body)) {
    switch (outcome.body.status) {
      case 'ready':
      case 'degraded':
        return 'ready';
      case 'starting':
        return 'starting';
      case 'stopping':
        return 'not-running';
      default:
        return 'foreign';
    }
  }
  if (outcome.marked) return outcome.status === 503 ? 'starting' : 'refused';
  if (outcome.status >= 500 && outcome.status <= 599) return 'proxy-unreachable';
  return 'foreign';
}

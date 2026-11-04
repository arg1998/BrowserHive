/** @module lib/api/rest-health — REST health from how requests ended, never from how long ago one ran: an idle page stays healthy; a network error, timeout or daemon 5xx marks it failing until a later answer (issue #50) */
import type { QueryClient } from '@tanstack/react-query';
import { type AppError, isAppError } from './errors.ts';

/** What the connection pill knows about REST. */
export interface RestHealth {
  /** The last request that could not reach a working daemon; `null` while healthy. */
  readonly failure: AppError | null;
  /** Browser-clock ms of the last answer from the daemon; `null` before the first one. */
  readonly lastAnswerAt: number | null;
}

/** The state before any request finished. */
export const REST_HEALTH_UNKNOWN: RestHealth = { failure: null, lastAnswerAt: null };

/**
 * While failing, probe this often so a single blip on a quiet page (nothing else refetches) does not
 * leave the pill Degraded until the next click.
 */
export const REST_PROBE_MS = 15_000;

/**
 * `true` when an error means the daemon could not be reached or broke: a network error, a timeout,
 * or an `INTERNAL_ERROR` 5xx that is not the daemon's own JSON answer (a proxy's 502/504, or the
 * daemon's internal error). The daemon's typed 5xx (`NAVIGATION_FAILED`, `CHANNEL_PLATFORM_ERROR`,
 * …) report a failed operation, not a failed connection; 4xx, aborts and malformed bodies show the
 * daemon answered (the same exclusions as `shouldRetry`). A 503 from `/health` carries its JSON
 * body: the daemon answered, the System page shows why it is degraded.
 */
export function isRestOutage(error: unknown): boolean {
  if (!isAppError(error)) return false;
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return true;
  if (error.code !== 'INTERNAL_ERROR' || error.status < 500) return false;
  const body = error.details['body'];
  return typeof body !== 'object' || body === null;
}

/** The next state after a request ended (pure; exported for tests). */
export function nextRestHealth(
  state: RestHealth,
  outcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown },
  at: number,
): RestHealth {
  if (outcome.ok) return { failure: null, lastAnswerAt: at };
  if (isRestOutage(outcome.error) && isAppError(outcome.error))
    return { failure: outcome.error, lastAnswerAt: state.lastAnswerAt };
  // The daemon answered (4xx, a typed failure): not an outage, and not proof the outage is over.
  return { failure: state.failure, lastAnswerAt: at };
}

/** Options for {@link watchRestHealth}. */
export interface WatchRestHealthOptions {
  /** Called when REST starts or stops failing (not on every answer: the pill must not re-render per request). */
  readonly onChange: (health: RestHealth) => void;
  /** A cheap request (`GET /health`) used to recheck while failing; it resolves or throws an `AppError`. */
  readonly probe?: () => Promise<unknown>;
  /** Browser clock (injectable for tests). */
  readonly now?: () => number;
  /** Probe interval while failing (injectable for tests). */
  readonly probeMs?: number;
}

/**
 * Follows every query and mutation of `client` to completion and reports {@link RestHealth}. Cache
 * writes from the realtime bridge (`setQueryData`, `manual`) are not REST answers and are ignored.
 * `current()` reads the latest state (including `lastAnswerAt`) at any time.
 */
export function watchRestHealth(
  client: QueryClient,
  options: WatchRestHealthOptions,
): { readonly current: () => RestHealth; readonly dispose: () => void } {
  const now = options.now ?? Date.now;
  const probeMs = options.probeMs ?? REST_PROBE_MS;
  let state = initialRestHealth(client);
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const apply = (next: RestHealth) => {
    if (disposed) return;
    const failureChanged = next.failure !== state.failure;
    const failingChanged = (next.failure === null) !== (state.failure === null);
    state = next;
    if (failureChanged) options.onChange(state);
    if (failingChanged) scheduleProbe();
  };
  const record = (
    outcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown },
  ) => apply(nextRestHealth(state, outcome, now()));

  const scheduleProbe = () => {
    if (probeTimer !== null) clearTimeout(probeTimer);
    probeTimer = null;
    const probe = options.probe;
    if (state.failure === null || probe === undefined || disposed) return;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      probe().then(
        () => record({ ok: true }),
        (error: unknown) => {
          // Any answer from the daemon ends the outage; another outage keeps probing.
          if (isRestOutage(error)) scheduleProbe();
          else record({ ok: true });
        },
      );
    }, probeMs);
  };

  const unsubscribeQueries = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    const { action } = event;
    if (action.type === 'success' && action.manual !== true) record({ ok: true });
    else if (action.type === 'error') record({ ok: false, error: action.error });
  });
  const unsubscribeMutations = client.getMutationCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    const { action } = event;
    if (action.type === 'success') record({ ok: true });
    else if (action.type === 'error') record({ ok: false, error: action.error });
  });

  scheduleProbe();
  return {
    current: () => state,
    dispose: () => {
      disposed = true;
      unsubscribeQueries();
      unsubscribeMutations();
      if (probeTimer !== null) clearTimeout(probeTimer);
    },
  };
}

/** The state the cache already implies when the pill mounts after some queries finished. */
function initialRestHealth(client: QueryClient): RestHealth {
  let lastAnswerAt = 0;
  let failure: AppError | null = null;
  let failureAt = 0;
  for (const query of client.getQueryCache().getAll()) {
    const { dataUpdatedAt, error, errorUpdatedAt } = query.state;
    if (dataUpdatedAt > lastAnswerAt) lastAnswerAt = dataUpdatedAt;
    if (error !== null && errorUpdatedAt > failureAt && isRestOutage(error) && isAppError(error)) {
      failure = error;
      failureAt = errorUpdatedAt;
    }
  }
  return {
    failure: failure !== null && failureAt > lastAnswerAt ? failure : null,
    lastAnswerAt: lastAnswerAt === 0 ? null : lastAnswerAt,
  };
}

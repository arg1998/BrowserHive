/** @module app/providers/auth-machine — pure auth state machine: loading → login | change | ready; transient probe failures keep the last known principal and retry with backoff instead of replacing the app (spec 04 §4.1) */
import type { AuthPrincipal, MeResponse } from '@browserhive/contracts/http';
import type { AppError } from '@/lib/api/errors.ts';

/**
 * Auth status. `error` is reached only when there is no known principal and the probe failed with a
 * non-transient error (a contract mismatch, a dashboard bug). `offline` stays in the union for callers
 * that match on it; the machine does not produce it (an unreachable daemon is a retried
 * `loading`, or a `ready` shell with a banner when the operator is known).
 */
export type AuthStatus = 'loading' | 'login' | 'change' | 'ready' | 'error' | 'offline';

/** A failed probe being retried. */
export interface AuthRetry {
  readonly error: AppError;
  /** Delay before the next probe. */
  readonly delayMs: number;
  /** When the failure was recorded (epoch ms), for a countdown. */
  readonly at: number;
}

/** Auth state. */
export interface AuthState {
  readonly status: AuthStatus;
  /** Last known principal: from the last successful probe, or the one cached from a previous visit. */
  readonly principal: AuthPrincipal | null;
  readonly error: AppError | null;
  /** Consecutive failed probes (drives the retry backoff). */
  readonly attempt: number;
  /** A probe should run now. */
  readonly pending: boolean;
  /** Set while probes fail and are being retried; cleared by the next successful probe. */
  readonly retry: AuthRetry | null;
}

/** Events. */
export type AuthEvent =
  | { readonly type: 'probe.start' }
  | { readonly type: 'probe.ok'; readonly me: MeResponse }
  | { readonly type: 'probe.unauthorized' }
  | {
      readonly type: 'probe.failed';
      readonly error: AppError;
      readonly delayMs: number;
      readonly at: number;
    }
  | { readonly type: 'unauthorized' }
  | { readonly type: 'password_change_required' }
  | { readonly type: 'logged_in'; readonly mustChange: boolean }
  | { readonly type: 'password_changed' }
  | { readonly type: 'logged_out' }
  | { readonly type: 'retry' };

/** Initial state; `principal` is the one cached from the last visit, if any. */
export function initialAuthState(
  principal: AuthPrincipal | null = null,
  options: { readonly skipProbe?: boolean } = {},
): AuthState {
  // On the login page with nothing cached there is nobody to check: skip the probe (and its 401).
  if (options.skipProbe === true && principal === null) {
    return {
      status: 'login',
      principal: null,
      error: null,
      attempt: 0,
      pending: false,
      retry: null,
    };
  }
  return { status: 'loading', principal, error: null, attempt: 0, pending: true, retry: null };
}

/** Initial state without a cached principal. */
export const INITIAL_AUTH_STATE: AuthState = initialAuthState();

/** Probe timeout (spec 04 §4.1). */
export const AUTH_PROBE_TIMEOUT_MS = 8_000;

/** Backoff for failed probes: 1 s doubling to 30 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
}

/**
 * Delay before retrying after `error` on the `attempt`-th consecutive failure: the backoff, never
 * shorter than the daemon's `retry-after`, with ±10% jitter so tabs sharing a rate limit spread out.
 */
export function probeRetryDelayMs(error: AppError, attempt: number, random = Math.random): number {
  const base = Math.max(retryDelayMs(attempt), error.retryAfterMs ?? 0);
  return Math.round(base * (0.9 + random() * 0.2));
}

/**
 * Is a probe failure transient (the session is probably fine, the daemon is busy or unreachable)?
 * Rate limits, timeouts, network failures and 5xx are; contract mismatches and dashboard bugs are not.
 */
export function isTransientAuthError(error: AppError): boolean {
  if (error.code === 'RATE_LIMITED' || error.status === 429) return true;
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return true;
  return error.status >= 500;
}

/** Operator-facing wording for a failed probe (no codes or request ids). */
export function authRetryCopy(error: AppError): { readonly title: string; readonly body: string } {
  if (error.code === 'RATE_LIMITED' || error.status === 429) {
    return {
      title: 'The daemon is rate limiting this browser',
      body: 'Too many requests from open dashboard tabs. Your work is safe.',
    };
  }
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') {
    return {
      title: "Can't reach the daemon",
      body: 'It may be restarting, or the network is down.',
    };
  }
  if (error.status >= 500) {
    return { title: 'The daemon ran into a problem', body: 'It answered with a server error.' };
  }
  return {
    title: "Couldn't check your session",
    body: 'The daemon gave an answer the dashboard did not understand.',
  };
}

/** Status for a known principal. */
function statusOf(principal: AuthPrincipal): AuthStatus {
  return principal.must_change_password ? 'change' : 'ready';
}

const SIGNED_OUT: AuthState = {
  status: 'login',
  principal: null,
  error: null,
  attempt: 0,
  pending: false,
  retry: null,
};

/** Reducer. Never drops to `login` on transport failures, and never replaces a known shell with an error. */
export function reduceAuth(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case 'probe.start':
      return { ...state, pending: false };
    case 'probe.ok':
      return {
        status: statusOf(event.me.principal),
        principal: event.me.principal,
        error: null,
        attempt: 0,
        pending: false,
        retry: null,
      };
    case 'probe.unauthorized':
      return SIGNED_OUT;
    case 'probe.failed': {
      const retry: AuthRetry = { error: event.error, delayMs: event.delayMs, at: event.at };
      const attempt = state.attempt + 1;
      if (state.principal !== null) {
        // Keep the shell (or the change-password page) for the operator we know about.
        const status =
          state.status === 'ready' || state.status === 'change'
            ? state.status
            : statusOf(state.principal);
        return { ...state, status, error: event.error, attempt, pending: false, retry };
      }
      const status = isTransientAuthError(event.error) ? 'loading' : 'error';
      return { ...state, status, error: event.error, attempt, pending: false, retry };
    }
    case 'unauthorized':
      return SIGNED_OUT;
    case 'password_change_required':
      return state.status === 'login' ? state : { ...state, status: 'change', error: null };
    case 'logged_in':
      return event.mustChange
        ? { ...state, status: 'change', error: null, attempt: 0, pending: false, retry: null }
        : { ...state, status: 'loading', error: null, attempt: 0, pending: true, retry: null };
    case 'password_changed':
      return { ...state, status: 'loading', error: null, attempt: 0, pending: true, retry: null };
    case 'logged_out':
      return SIGNED_OUT;
    case 'retry':
      return state.retry === null && state.status !== 'error' ? state : { ...state, pending: true };
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled auth event ${JSON.stringify(value)}`);
}

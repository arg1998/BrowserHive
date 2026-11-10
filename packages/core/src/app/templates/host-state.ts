/** @module app/templates/host-state — the template host's states and the pure rules of its supervisor (spec 13 §3.2): restart backoff, the failure window, failure classification and the idle and recycle clocks. */

import { isAppError } from '../../kernel/errors/app-error.ts';

/** A host's state (spec 13 §3.2). */
export type HostState = 'stopped' | 'starting' | 'running' | 'draining' | 'crashed' | 'failed';

/** Operator-facing cause of a `failed` host (`TEMPLATE_HOST_FAILED.reason`). */
export type HostFailure =
  | 'host_failed'
  | 'no_display'
  | 'proxy_unreachable'
  | 'sandbox_unavailable';

/** Restart delays after consecutive crashes or failed starts (spec 13 §3.2). */
export const RESTART_BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000, 135_000, 405_000];
/** The window in which consecutive failures count. */
export const FAILURE_WINDOW_MS = 30 * 60_000;
/** Failures within the window that set `failed`. */
export const MAX_FAILURES = 5;
/** Deadline of one host start (spec 13 §3.2 `starting`). */
export const HOST_START_DEADLINE_MS = 60_000;
/** A virtual-session launch's total budget, below common MCP clients' 60 s timeout (spec 13 §3.7). */
export const TEMPLATE_LAUNCH_BUDGET_MS = 50_000;

/** True while the host holds a browser slot (spec 13 §6.3; a draining host's browser is still up). */
export function holdsSlot(state: HostState): boolean {
  return state === 'starting' || state === 'running' || state === 'draining';
}

/**
 * Consecutive failures (crashes and failed starts) within {@link FAILURE_WINDOW_MS}; an operator
 * stop or restart clears them.
 */
export class FailureWindow {
  private readonly at: number[] = [];

  /** Records one failure at `now`; returns how many fall inside the window. */
  record(now: number): number {
    this.at.push(now);
    while (this.at.length > 0 && now - (this.at[0] ?? now) > FAILURE_WINDOW_MS) this.at.shift();
    return this.at.length;
  }

  /** The delay before the next restart after `count` failures. */
  static backoff(count: number): number {
    const index = Math.min(Math.max(count, 1), RESTART_BACKOFF_MS.length) - 1;
    return RESTART_BACKOFF_MS[index] ?? RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1] ?? 5_000;
  }

  clear(): void {
    this.at.length = 0;
  }
}

/**
 * A failed start that no restart can fix (spec 13 §3.2 `failed`): no display, an unreachable proxy,
 * no sandbox under `sandbox=on`. `null`: an ordinary failure that counts toward the window.
 */
export function permanentFailure(err: unknown): HostFailure | null {
  if (!isAppError(err)) return null;
  if (err.code === 'SANDBOX_UNAVAILABLE') return 'sandbox_unavailable';
  const ref: unknown = (err.details as { readonly ref?: unknown } | undefined)?.ref;
  if (ref === 'no_display') return 'no_display';
  if (ref === 'proxy_unreachable') return 'proxy_unreachable';
  return null;
}

/** The idle stop rule (spec 13 §3.2): `null` when the host is in use, else when it went idle. */
export function nextIdleSince(
  idleSince: number | null,
  inUse: boolean,
  now: number,
): number | null {
  if (inUse) return null;
  return idleSince ?? now;
}

/** True when an idle host should stop now (`timeoutMs` 0 = never). */
export function idleExpired(idleSince: number | null, timeoutMs: number, now: number): boolean {
  return timeoutMs > 0 && idleSince !== null && now - idleSince >= timeoutMs;
}

/** When a host started at `startedAt` is due for recycling (`afterMs` 0 = never). */
export function recycleAt(startedAt: number | null, afterMs: number): number | null {
  return startedAt === null || afterMs <= 0 ? null : startedAt + afterMs;
}

/** @module domain/session/session — the Session aggregate: identity, flags, state machine, lease, tabs, warnings, counters. */

import type { ClosedReason, StealthDriverName } from '@browserhive/contracts/enums';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Result } from '../../kernel/result.ts';
import type { AppliedIdentity, SessionHandle } from '../../ports/browser-driver.ts';
import type { CreateSessionRequest } from './create-request.ts';
import {
  isLeaseExpired,
  type Lease,
  leaseRemainingMs,
  newLease,
  pauseLease,
  resumeLease,
  touchLease,
} from './lease.ts';
import {
  reserved,
  type SessionEvent,
  type SessionState,
  type TransitionError,
  transition,
} from './state.ts';
import { TabRegistry } from './tabs.ts';
import type { SessionWarning } from './warnings.ts';

/** Per-session live counters (mirrored to `SessionCounts` on the wire, plus `navigations` for `session_info`). */
export interface SessionCounters {
  toolCalls: number;
  errors: number;
  pages: number;
  blocked: number;
  attentionOpen: number;
  vaultAccess: number;
  navigations: number;
}

/** A counter name. */
export type SessionCounter = keyof SessionCounters;

/** What the pipeline knows once the driver has launched. */
export interface LaunchAttachment {
  readonly handle: SessionHandle;
  readonly driver: StealthDriverName;
  readonly launchedAt: number;
  readonly launchMs: number;
}

/** Inputs to construct a reserved session. */
export interface SessionSeed {
  readonly id: string;
  readonly request: CreateSessionRequest;
  readonly createdAt: number;
  readonly leaseWindowMs: number;
  /** Mints `t-<nanoid6>` ids for the tab registry. */
  readonly tabId: () => string;
}

/**
 * One browser session. Mutation happens only through the explicit methods below; the state machine
 * (`domain/session/state.ts`) and the lease (`domain/session/lease.ts`) stay pure and are applied
 * here. The aggregate never touches I/O: the driver handle is attached by the pipeline and closed by
 * the service.
 */
export class Session {
  readonly id: string;
  readonly slug: string;
  readonly request: CreateSessionRequest;
  readonly createdAt: number;
  readonly tabs: TabRegistry;
  readonly warnings: SessionWarning[] = [];
  readonly counts: SessionCounters = {
    toolCalls: 0,
    errors: 0,
    pages: 0,
    blocked: 0,
    attentionOpen: 0,
    vaultAccess: 0,
    navigations: 0,
  };

  private currentState: SessionState;
  private currentLease: Lease;
  private attachment: LaunchAttachment | null = null;
  private appliedIdentity: AppliedIdentity | null = null;
  private label: string | null = null;
  private restoredSeed: string | null = null;
  private url: string | null = null;
  private toolAt: number;
  private activityAt: number;

  constructor(seed: SessionSeed) {
    this.id = seed.id;
    this.slug = seed.request.slug;
    this.request = seed.request;
    this.createdAt = seed.createdAt;
    this.currentState = reserved(seed.createdAt);
    this.currentLease = newLease(seed.createdAt, seed.leaseWindowMs);
    this.toolAt = seed.createdAt;
    this.activityAt = seed.createdAt;
    this.tabs = new TabRegistry(seed.id, seed.tabId);
  }

  // --- identity and flags (frozen at creation) ---------------------------------------------------

  /** Owning principal subject. */
  get owner(): string {
    return this.request.owner;
  }

  /** Current lifecycle state. */
  get state(): SessionState {
    return this.currentState;
  }

  /** Current lease. */
  get lease(): Lease {
    return this.currentLease;
  }

  /** The driver handle once launched; `null` while reserved/launching or after teardown. */
  get handle(): SessionHandle | null {
    return this.attachment?.handle ?? null;
  }

  /** Which driver launched the browser, once known. */
  get driver(): StealthDriverName | null {
    return this.attachment?.driver ?? null;
  }

  /** Epoch ms the browser became usable, once known. */
  get launchedAt(): number | null {
    return this.attachment?.launchedAt ?? null;
  }

  /** Pipeline duration from reserve to live, once known. */
  get launchMs(): number | null {
    return this.attachment?.launchMs ?? null;
  }

  /** The presented identity, or `null` (stealth off, or `applyIdentity` failed). */
  get identity(): AppliedIdentity | null {
    return this.appliedIdentity;
  }

  /**
   * The display/fingerprint seed: the seed restored with a saved profile (`<name>.identity.json`),
   * otherwise the session id (the identity resolver's default). Saved beside a profile snapshot.
   */
  get identitySeed(): string {
    return this.restoredSeed ?? this.id;
  }

  /** Operator-facing proxy label (D-13), or `null`. */
  get proxyLabel(): string | null {
    return this.label;
  }

  /** Last URL a tool reported for the session, or `null`. */
  get currentUrl(): string | null {
    return this.url;
  }

  /** Epoch ms of the last tool lookup (`session_info.last_tool_at`). */
  get lastToolAt(): number {
    return this.toolAt;
  }

  /** Epoch ms of the last activity of any kind (`sessions.last_activity_at`). */
  get lastActivityAt(): number {
    return this.activityAt;
  }

  /** True once the browser crashed (tools answer `SESSION_DEAD`). */
  get dead(): boolean {
    return this.currentState.kind === 'crashed';
  }

  /** The close reason once draining/closed, `'crash'` once crashed, else `null`. */
  get closedReason(): ClosedReason | null {
    const state = this.currentState;
    if (state.kind === 'draining' || state.kind === 'closed') return state.reason;
    if (state.kind === 'crashed') return 'crash';
    return null;
  }

  /** Epoch ms the session reached a terminal state, else `null`. */
  get closedAt(): number | null {
    const state = this.currentState;
    return state.kind === 'closed' || state.kind === 'crashed' ? state.at : null;
  }

  // --- state machine -----------------------------------------------------------------------------

  /** Applies a lifecycle event without throwing. */
  tryApply(event: SessionEvent): Result<SessionState, TransitionError> {
    const result = transition(this.currentState, event);
    if (result.ok) {
      this.currentState = result.value;
      this.activityAt = Math.max(this.activityAt, event.at);
    }
    return result;
  }

  /**
   * Applies a lifecycle event.
   *
   * @throws `SESSION_NOT_LIVE` when the caller asked for something only a running session can do;
   *   `INTERNAL_ERROR` when the service drove the machine out of order.
   */
  apply(event: SessionEvent): SessionState {
    const result = this.tryApply(event);
    if (result.ok) return result.value;
    const failure = result.error;
    if (failure.code === 'SESSION_NOT_LIVE') {
      throw new AppError(
        'SESSION_NOT_LIVE',
        { session_id: this.id },
        { publicMessage: `Session '${this.id}' is not live.`, message: failure.message },
      );
    }
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'session-transition' },
      { message: failure.message },
    );
  }

  // --- lease -------------------------------------------------------------------------------------

  /** Resets the sliding lease and stamps `lastToolAt` (called by `SessionService.get`). */
  touch(now: number, windowMs: number): void {
    this.toolAt = now;
    this.activityAt = now;
    this.currentLease = touchLease(this.currentLease, now, windowMs);
  }

  /** Freezes the lease (banked remaining time). Idempotent. */
  pauseLease(now: number): void {
    this.currentLease = pauseLease(this.currentLease, now);
  }

  /** Restores the banked remaining time. Idempotent. */
  resumeLease(now: number): void {
    this.currentLease = resumeLease(this.currentLease, now);
  }

  /** True once the lease expired; never while paused. */
  isLeaseExpired(now: number): boolean {
    return isLeaseExpired(this.currentLease, now);
  }

  /** Milliseconds of lease left. */
  leaseRemainingMs(now: number): number {
    return leaseRemainingMs(this.currentLease, now);
  }

  // --- launch outcome ----------------------------------------------------------------------------

  /** Records the launched driver handle and its facts. */
  attach(attachment: LaunchAttachment): void {
    this.attachment = attachment;
    this.appliedIdentity = attachment.handle.identity;
  }

  /** Drops the driver handle after teardown so nothing can drive a closed browser. */
  detach(): void {
    this.attachment = null;
  }

  /** Records the presented identity (kept separate from `attach` for the `applyIdentity` phase). */
  setIdentity(identity: AppliedIdentity | null): void {
    this.appliedIdentity = identity;
  }

  /** Adopts the identity seed restored with a saved profile. */
  setIdentitySeed(seed: string | null): void {
    this.restoredSeed = seed;
  }

  /** Records the proxy label (D-13). */
  setProxyLabel(label: string | null): void {
    this.label = label;
  }

  /** Appends a warning (kept in order; duplicates allowed — they are distinct occurrences). */
  addWarning(warning: SessionWarning): void {
    this.warnings.push(warning);
  }

  /** Records the URL a tool observed, stamping activity. */
  setCurrentUrl(url: string | null, at: number): void {
    this.url = url;
    this.activityAt = Math.max(this.activityAt, at);
  }

  /** Increments a counter (never below zero). */
  bump(counter: SessionCounter, delta = 1): void {
    this.counts[counter] = Math.max(0, this.counts[counter] + delta);
  }
}

/** @module lib/daemon-help/watcher — the daemon reachability watcher behind `DaemonReachabilityProvider` (04 §18.7), framework-free: REST health from how requests ended (§6.1), the only `/health` prober (15 s rechecks while REST fails; a 5 s outage cadence once the socket gives up), and the daemon-unreachable banner state. */
import type { QueryClient } from '@tanstack/react-query';
import type { AppError } from '@/lib/api/errors.ts';
import {
  followRestOutcomes,
  initialRestHealth,
  nextRestHealth,
  REST_HEALTH_UNKNOWN,
  REST_PROBE_MS,
  type RestHealth,
  type RestOutcome,
} from '@/lib/api/rest-health.ts';
import { browserClock, browserTimers, type Clock, type Timers } from '@/lib/clock.ts';
import type { OfflineReason, SocketStatus } from '@/lib/ws/store.ts';
import {
  classifyProbe,
  isDaemonAnswer,
  type ProbeFetch,
  type ProbeOutcome,
  type ProbeState,
  probeHealth,
} from './probe.ts';

/** Once the socket gives up, a probe starts this long after the previous one started (or when it settles, if later). */
export const OUTAGE_PROBE_MS = 5_000;
/** Consecutive outage-cadence probes that must fail before the banner shows. */
export const BANNER_AFTER_PROBES = 3;
/** A gap longer than this between two outage probes (sleep, a throttled tab) restarts the count. */
export const OUTAGE_GAP_RESET_MS = 15_000;

/** The probe states that count toward the banner: nothing (or nothing useful) answers. */
const COUNTED: ReadonlySet<ProbeState> = new Set([
  'not-running',
  'not-responding',
  'proxy-unreachable',
]);

/** What the shell shows; a new object only when something visible changes. */
export interface ReachabilitySnapshot {
  /** The last request that could not reach a working daemon; `null` while REST is healthy. */
  readonly restFailure: AppError | null;
  /**
   * The state the banner describes, or `null` while it is hidden. It first shows for a counted
   * state; while shown it follows the latest outage probe (e.g. `device-offline`).
   */
  readonly banner: ProbeState | null;
}

/** Healthy, no banner. */
export const HIDDEN_SNAPSHOT: ReachabilitySnapshot = { restFailure: null, banner: null };

/** Options; every input is injectable for tests. */
export interface DaemonReachabilityOptions {
  readonly client: QueryClient;
  /** The probe's fetch (default: the global `fetch`, read at call time). */
  readonly fetch?: ProbeFetch;
  /** Timers for the schedule and the probe timeout (default `browserTimers`). */
  readonly timers?: Timers;
  /** The clock the schedule and the gap rule read; it must agree with `timers` (default `browserClock`). */
  readonly clock?: Clock;
  /** The clock of "Last answer" (default `browserClock`, compared with the browser clock at render). */
  readonly wallClock?: Clock;
  /** `navigator.onLine` (default: read it; `true` when there is no navigator). */
  readonly online?: () => boolean;
  readonly restProbeMs?: number;
  readonly outageProbeMs?: number;
  readonly bannerAfter?: number;
  readonly gapResetMs?: number;
}

function navigatorOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * The watcher (framework-free, so it can be tested with manual timers). `start()` follows the
 * query cache; `socketChanged()` feeds it the socket store's state; `stop()` ends everything.
 * At most one probe is in flight at any time.
 */
export class DaemonReachability {
  private rest: RestHealth = REST_HEALTH_UNKNOWN;
  private snapshot: ReachabilitySnapshot = HIDDEN_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private unfollow: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private emitQueued = false;
  /** Bumped by every outage start and stop, so a probe that outlived its outage is not counted. */
  private generation = 0;
  private outage = false;
  private lastOutageStart: number | null = null;
  private failures = 0;
  private socket: { status: SocketStatus; reason: OfflineReason | null } = {
    status: 'idle',
    reason: null,
  };
  private readonly timers: Timers;
  private readonly clock: Clock;
  private readonly wallClock: Clock;
  private readonly online: () => boolean;
  private readonly cfg: {
    readonly restProbeMs: number;
    readonly outageProbeMs: number;
    readonly bannerAfter: number;
    readonly gapResetMs: number;
  };

  constructor(private readonly options: DaemonReachabilityOptions) {
    this.timers = options.timers ?? browserTimers;
    this.clock = options.clock ?? browserClock;
    this.wallClock = options.wallClock ?? browserClock;
    this.online = options.online ?? navigatorOnline;
    this.cfg = {
      restProbeMs: options.restProbeMs ?? REST_PROBE_MS,
      outageProbeMs: options.outageProbeMs ?? OUTAGE_PROBE_MS,
      bannerAfter: options.bannerAfter ?? BANNER_AFTER_PROBES,
      gapResetMs: options.gapResetMs ?? OUTAGE_GAP_RESET_MS,
    };
  }

  /** The current snapshot (stable between changes, for `useSyncExternalStore`). */
  readonly getSnapshot = (): ReachabilitySnapshot => this.snapshot;

  /** Observe snapshot changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Browser-clock ms of the last answer from the daemon (REST or a marked probe); `null` before one. */
  lastAnswerAt(): number | null {
    return this.rest.lastAnswerAt;
  }

  /** Follow the query cache (idempotent; `stop()` undoes it, and `start()` may run again). */
  start(): void {
    if (this.unfollow !== null) return;
    this.rest = initialRestHealth(this.options.client);
    this.unfollow = followRestOutcomes(this.options.client, (outcome) => this.record(outcome));
    this.publish();
    this.scheduleNext();
  }

  /** Stop following, cancel the schedule and forget the outage. */
  stop(): void {
    this.unfollow?.();
    this.unfollow = null;
    this.clearTimer();
    this.generation += 1;
    this.outage = false;
    this.socket = { status: 'idle', reason: null };
  }

  /** The socket store's state changed. */
  socketChanged(status: SocketStatus, reason: OfflineReason | null): void {
    const previous = this.socket;
    this.socket = { status, reason };
    if (status === 'connected') {
      this.daemonAnswered();
      return;
    }
    if (status === 'offline' && reason === 'network') {
      if (previous.status !== 'offline' || previous.reason !== 'network') this.startOutage();
      return;
    }
    // Signed out, a password change, a protocol mismatch: the daemon answered. Idle: torn down.
    if (status === 'offline' || status === 'idle') this.daemonAnswered();
  }

  // -- schedule --------------------------------------------------------------------------------

  private startOutage(): void {
    if (this.unfollow === null) return;
    this.generation += 1;
    this.outage = true;
    this.lastOutageStart = null;
    this.failures = 0;
    this.scheduleNext();
  }

  /** Something proved the daemon reachable: hide the banner, end the outage cadence. */
  private daemonAnswered(): void {
    const wasOutage = this.outage;
    if (wasOutage) this.generation += 1;
    this.outage = false;
    this.failures = 0;
    this.lastOutageStart = null;
    this.setBanner(null);
    if (wasOutage) this.scheduleNext();
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (this.unfollow === null || this.inflight) return;
    if (this.outage) {
      const delay =
        this.lastOutageStart === null
          ? 0
          : Math.max(0, this.lastOutageStart + this.cfg.outageProbeMs - this.clock());
      this.timer = this.timers.setTimeout(() => this.runProbe(true), delay);
    } else if (this.rest.failure !== null) {
      this.timer = this.timers.setTimeout(() => this.runProbe(false), this.cfg.restProbeMs);
    }
  }

  private runProbe(outage: boolean): void {
    this.timer = null;
    this.inflight = true;
    const generation = this.generation;
    if (outage) {
      const startedAt = this.clock();
      if (this.lastOutageStart !== null && startedAt - this.lastOutageStart > this.cfg.gapResetMs) {
        this.failures = 0;
      }
      this.lastOutageStart = startedAt;
    }
    void probeHealth({
      timers: this.timers,
      ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
    }).then((outcome) => {
      this.inflight = false;
      if (this.unfollow === null) return;
      this.settled(outcome, outage && generation === this.generation);
    });
  }

  private settled(outcome: ProbeOutcome, counts: boolean): void {
    if (isDaemonAnswer(outcome)) {
      // Any marked answer, a degraded 503 or a malformed 200 included, ends both outages.
      this.applyRest(nextRestHealth(this.rest, { ok: true }, this.wallClock()));
      this.daemonAnswered();
      this.scheduleNext();
      return;
    }
    if (counts) {
      const state = classifyProbe(outcome, { online: this.online() });
      this.failures = COUNTED.has(state) ? this.failures + 1 : 0;
      if (this.snapshot.banner !== null || this.failures >= this.cfg.bannerAfter) {
        this.setBanner(state);
      }
    }
    this.scheduleNext();
  }

  // -- REST --------------------------------------------------------------------------------------

  private record(outcome: RestOutcome): void {
    this.applyRest(nextRestHealth(this.rest, outcome, this.wallClock()));
    if (outcome.ok) this.daemonAnswered();
  }

  private applyRest(next: RestHealth): void {
    const failingChanged = (next.failure === null) !== (this.rest.failure === null);
    this.rest = next;
    this.publish();
    if (failingChanged && !this.outage) this.scheduleNext();
  }

  // -- plumbing ----------------------------------------------------------------------------------

  private setBanner(banner: ProbeState | null): void {
    if (this.snapshot.banner === banner) return;
    this.snapshot = { ...this.snapshot, banner };
    this.emit();
  }

  private publish(): void {
    if (this.snapshot.restFailure === this.rest.failure) return;
    this.snapshot = { ...this.snapshot, restFailure: this.rest.failure };
    this.emit();
  }

  /**
   * Listeners hear of a change on the next microtask: query-cache events fire while a component
   * renders a new query, and no other component may update mid-render. Changes in one task coalesce.
   */
  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      for (const listener of this.listeners) listener();
    });
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

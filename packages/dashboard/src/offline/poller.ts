/** @module offline/poller — when the offline page probes (04 §18.6.4): at load, then after 1 s, 2 s and every 3 s while the page is visible; at once on `online`, on becoming visible and on Retry now. Timers and clock are injected. */
import type { Clock, Timers } from '../lib/clock.ts';
import type { ProbeOutcome } from '../lib/daemon-help/probe.ts';

/** Delays between the end of one probe and the start of the next; the last one repeats. */
export const POLL_DELAYS_MS: readonly number[] = [1_000, 2_000, 3_000];

/** What the poller needs. */
export interface PollerDeps {
  readonly probe: () => Promise<ProbeOutcome>;
  readonly timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  readonly clock: Clock;
  /** `document.visibilityState !== 'hidden'`. */
  readonly isVisible: () => boolean;
  /** Called when a probe starts. */
  readonly onProbe: () => void;
  /** Called with each outcome; the poller schedules the next probe afterwards unless stopped. */
  readonly onOutcome: (outcome: ProbeOutcome) => void;
  /** Called once the next probe is scheduled ({@link Poller.nextAt} is set). */
  readonly onScheduled?: () => void;
}

/** Drives the probes. */
export class Poller {
  private step = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private stopped = false;
  private nextAtMs: number | null = null;

  constructor(private readonly deps: PollerDeps) {}

  /** When the next probe starts (epoch ms); `null` while probing, hidden or stopped. */
  get nextAt(): number | null {
    return this.nextAtMs;
  }

  /** True while a probe is in flight. */
  get probing(): boolean {
    return this.inFlight;
  }

  /** The first probe (only when visible; otherwise the first visibility change starts it). */
  start(): void {
    this.probeNow(false);
  }

  /**
   * Probes at once unless one is in flight. `reset` restarts the 1 s, 2 s, 3 s schedule (Retry
   * now); `online` and becoming visible keep it.
   */
  probeNow(reset: boolean): void {
    if (reset) this.step = 0;
    if (this.stopped || this.inFlight || !this.deps.isVisible()) return;
    this.clear();
    void this.run();
  }

  /** Call on `visibilitychange`: hidden pages never probe; a page that becomes visible probes at once. */
  visibilityChanged(): void {
    if (this.deps.isVisible()) this.probeNow(false);
    else this.clear();
  }

  /** Stops for good (the page is about to reload, or gave up). */
  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer);
    this.timer = null;
    this.nextAtMs = null;
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    this.deps.onProbe();
    const outcome = await this.deps.probe();
    this.inFlight = false;
    if (this.stopped) return;
    this.deps.onOutcome(outcome);
    if (this.stopped || !this.deps.isVisible()) return;
    const delay = POLL_DELAYS_MS[Math.min(this.step, POLL_DELAYS_MS.length - 1)] ?? 3_000;
    this.step += 1;
    this.nextAtMs = this.deps.clock() + delay;
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = null;
      this.nextAtMs = null;
      if (this.deps.isVisible()) void this.run();
    }, delay);
    this.deps.onScheduled?.();
  }
}

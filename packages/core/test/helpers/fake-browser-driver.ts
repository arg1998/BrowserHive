/** @module test/helpers/fake-browser-driver — FakeBrowserDriver: records LaunchSpecs; fail / hang / crash modes for pipeline and deadline tests (spec 09 §4). */

import type { BrowserDriver, LaunchSpec, SessionHandle } from '../../src/ports/browser-driver.ts';
import { FakeSessionHandle, type FakeSessionHandleOptions } from './fake-session-handle.ts';

/** A launch parked by `hang()`; `release()` lets it complete, `fail(err)` rejects it. */
export interface PendingLaunch {
  readonly spec: LaunchSpec;
  release(): void;
  fail(error: unknown): void;
}

/** In-memory `BrowserDriver`. */
export class FakeBrowserDriver implements BrowserDriver {
  readonly launches: LaunchSpec[] = [];
  readonly handles: FakeSessionHandle[] = [];
  readonly pending: PendingLaunch[] = [];
  /** What `stealthDriverName()` reports. */
  stealthName: 'patchright' | 'playwright' = 'playwright';
  /** Per-launch handle customisation. */
  handleOptions: (spec: LaunchSpec) => FakeSessionHandleOptions = () => ({});
  private nextFailure: unknown = undefined;
  private permanentFailure: unknown = undefined;
  private hanging = false;
  private readonly launchHooks: Array<(handle: FakeSessionHandle, spec: LaunchSpec) => void> = [];

  stealthDriverName(): 'patchright' | 'playwright' {
    return this.stealthName;
  }

  /** The next launch rejects with `error`. */
  failNextWith(error: unknown): void {
    this.nextFailure = error;
  }

  /** Every launch rejects with `error` until `reset()`. */
  failAlways(error: unknown): void {
    this.permanentFailure = error;
  }

  /**
   * Launches park until released. The parked promise deliberately ignores the abort signal so
   * deadline tests exercise the pipeline's own `raceSignal`.
   */
  hang(): void {
    this.hanging = true;
  }

  /** Clears every failure/hang mode. */
  reset(): void {
    this.nextFailure = undefined;
    this.permanentFailure = undefined;
    this.hanging = false;
  }

  /** Runs after each handle is created, before `launch` resolves (e.g. to crash mid-pipeline). */
  onLaunch(hook: (handle: FakeSessionHandle, spec: LaunchSpec) => void): void {
    this.launchHooks.push(hook);
  }

  /** Number of launches parked by `hang()`. */
  get pendingLaunches(): number {
    return this.pending.length;
  }

  /** Releases every parked launch. */
  releaseAll(): void {
    for (const p of [...this.pending]) p.release();
  }

  launch(spec: LaunchSpec, _signal?: AbortSignal): Promise<SessionHandle> {
    this.launches.push(spec);
    const failure = this.permanentFailure ?? this.nextFailure;
    if (failure !== undefined) {
      this.nextFailure = undefined;
      return Promise.reject(failure);
    }
    if (!this.hanging) return Promise.resolve(this.build(spec));
    return new Promise<SessionHandle>((resolve, reject) => {
      const entry: PendingLaunch = {
        spec,
        release: () => {
          this.forget(entry);
          resolve(this.build(spec));
        },
        fail: (error) => {
          this.forget(entry);
          reject(error);
        },
      };
      this.pending.push(entry);
    });
  }

  private forget(entry: PendingLaunch): void {
    const i = this.pending.indexOf(entry);
    if (i >= 0) this.pending.splice(i, 1);
  }

  private build(spec: LaunchSpec): FakeSessionHandle {
    const options = this.handleOptions(spec);
    const handle = new FakeSessionHandle(spec.sessionId, {
      ...(spec.tracing?.enabled === true && options.tracing === undefined && { tracing: true }),
      ...options,
    });
    this.handles.push(handle);
    for (const hook of this.launchHooks) hook(handle, spec);
    return handle;
  }
}

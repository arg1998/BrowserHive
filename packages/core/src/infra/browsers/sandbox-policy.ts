/** @module infra/browsers/sandbox-policy — the `sandbox` setting at launch time: one verdict per browser executable for the process lifetime, the `auto` fallback that never fails a launch, and required sandboxes (`on`, or an agent's `chromiumSandbox: true`) that fail fast with `SANDBOX_UNAVAILABLE` (plan §3.4, §4). */

import type { Channel, SandboxMode } from '@browserhive/contracts/enums';
import type { AppError } from '../../kernel/errors/app-error.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import { isSandboxFailure, sandboxFailureReason } from './sandbox.ts';

/** What is known about one executable. */
export type SandboxVerdict =
  | { readonly state: 'works' }
  | { readonly state: 'unavailable'; readonly reason: string };

/** The browser a launch uses: the cache key is its executable (or the channel when unknown). */
export interface SandboxTarget {
  readonly channel: Channel;
  readonly executablePath: string | null;
}

/** Who required the sandbox for one launch. */
export type SandboxRequirement = 'config' | 'launch_options';

/** One cached verdict, for `/system` and the per-session error. */
export interface SandboxStatusEntry {
  readonly channel: Channel;
  readonly executablePath: string | null;
  readonly state: 'works' | 'unavailable';
  readonly reason: string | null;
  readonly checkedAt: number;
}

/** Builds the error for a required sandbox this browser cannot provide (guidance comes from the caller). */
export type SandboxUnavailableFactory = (input: {
  readonly target: SandboxTarget;
  readonly reason: string;
  readonly requiredBy: SandboxRequirement;
  /** Channels whose executables are known to sandbox here. */
  readonly workingChannels: readonly Channel[];
  readonly err?: unknown;
}) => AppError;

/** Dependencies of {@link SandboxPolicy}. */
export interface SandboxPolicyDeps {
  readonly mode: SandboxMode;
  /** Running as uid 0: Chrome refuses the sandbox, so `auto` does not even try. */
  readonly root: boolean;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly unavailable: SandboxUnavailableFactory;
}

/** Outcome of {@link SandboxPolicy.launch}. */
export interface SandboxedLaunch<T> {
  readonly value: T;
  readonly sandboxed: boolean;
}

function keyOf(target: SandboxTarget): string {
  return target.executablePath ?? `channel:${target.channel}`;
}

/**
 * The per-process sandbox policy. `off` launches exactly as before; `auto` tries the sandbox once per
 * executable (on the first real launch), remembers the answer, and falls back to no sandbox with a
 * single `warn` log when the browser cannot sandbox; a required sandbox is never dropped silently.
 */
export class SandboxPolicy {
  private readonly verdicts = new Map<string, SandboxStatusEntry>();
  private readonly probing = new Map<string, Promise<void>>();
  private readonly log: Logger;

  constructor(private readonly deps: SandboxPolicyDeps) {
    this.log = deps.logger.child({ module: 'browsers.sandbox' });
  }

  /** The configured mode. */
  get mode(): SandboxMode {
    return this.deps.mode;
  }

  /** Whether the process runs as root (the sandbox is never attempted under `auto`). */
  get root(): boolean {
    return this.deps.root;
  }

  /** Records a verdict found elsewhere (the boot preflight). */
  record(target: SandboxTarget, verdict: SandboxVerdict): void {
    this.verdicts.set(keyOf(target), {
      channel: target.channel,
      executablePath: target.executablePath,
      state: verdict.state,
      reason: verdict.state === 'unavailable' ? verdict.reason : null,
      checkedAt: this.deps.clock.now(),
    });
  }

  /** The cached verdict for a browser, if any. */
  verdict(target: SandboxTarget): SandboxStatusEntry | undefined {
    return this.verdicts.get(keyOf(target));
  }

  /** Every cached verdict (for `/system`). */
  entries(): readonly SandboxStatusEntry[] {
    return [...this.verdicts.values()];
  }

  /** Channels whose browsers are known to sandbox here. */
  workingChannels(): readonly Channel[] {
    return [
      ...new Set(
        this.entries()
          .filter((e) => e.state === 'works')
          .map((e) => e.channel),
      ),
    ];
  }

  /**
   * Runs one launch under the policy. `attempt(true)` launches with `chromiumSandbox: true`,
   * `attempt(false)` without; the raw launch error propagates (callers map it).
   *
   * @throws `SANDBOX_UNAVAILABLE` when the sandbox is required and this browser cannot provide it.
   */
  async launch<T>(
    target: SandboxTarget,
    agentRequested: boolean,
    attempt: (sandbox: boolean) => Promise<T>,
    dispose: (value: T) => Promise<void> = async () => undefined,
  ): Promise<SandboxedLaunch<T>> {
    const required: SandboxRequirement | null =
      this.deps.mode === 'on' ? 'config' : agentRequested ? 'launch_options' : null;
    if (required !== null) return this.launchRequired(target, required, attempt, dispose);
    if (this.deps.mode === 'off' || this.deps.root) {
      return { value: await attempt(false), sandboxed: false };
    }
    return this.launchAuto(target, attempt);
  }

  private async launchRequired<T>(
    target: SandboxTarget,
    requiredBy: SandboxRequirement,
    attempt: (sandbox: boolean) => Promise<T>,
    dispose: (value: T) => Promise<void>,
  ): Promise<SandboxedLaunch<T>> {
    const known = this.verdict(target);
    if (known?.state === 'unavailable') {
      // Known not to sandbox: fail immediately instead of paying for another failed launch.
      throw this.error(target, known.reason ?? '', requiredBy);
    }
    try {
      const value = await attempt(true);
      this.record(target, { state: 'works' });
      return { value, sandboxed: true };
    } catch (err) {
      if (isAppError(err)) throw err;
      if (!isSandboxFailure(err)) {
        // Not a failure Chrome names as the sandbox (Edge's differs): the same browser starting
        // without it is the proof. It is closed again at once; the session never runs unsandboxed.
        let confirmed: T;
        try {
          confirmed = await attempt(false);
        } catch {
          throw err;
        }
        await dispose(confirmed).catch(() => undefined);
      }
      const reason = sandboxFailureReason(err);
      this.record(target, { state: 'unavailable', reason });
      throw this.error(target, reason, requiredBy, err);
    }
  }

  private async launchAuto<T>(
    target: SandboxTarget,
    attempt: (sandbox: boolean) => Promise<T>,
  ): Promise<SandboxedLaunch<T>> {
    const key = keyOf(target);
    // One launch per executable decides; concurrent first launches wait for it.
    const pending = this.probing.get(key);
    if (pending !== undefined) await pending;
    const known = this.verdict(target);
    if (known?.state === 'unavailable') return { value: await attempt(false), sandboxed: false };
    if (known?.state === 'works') {
      try {
        return { value: await attempt(true), sandboxed: true };
      } catch (err) {
        if (isAppError(err) || !isSandboxFailure(err)) throw err;
        return this.fallBack(target, err, attempt);
      }
    }
    let done: () => void = () => undefined;
    this.probing.set(
      key,
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    try {
      try {
        const value = await attempt(true);
        this.record(target, { state: 'works' });
        return { value, sandboxed: true };
      } catch (err) {
        if (isAppError(err)) throw err;
        // The sandbox is blamed only if the same browser then starts without it (as the probe
        // does); when that fails too, its own error surfaces and nothing is cached.
        return await this.fallBack(target, err, attempt);
      }
    } finally {
      this.probing.delete(key);
      done();
    }
  }

  private async fallBack<T>(
    target: SandboxTarget,
    err: unknown,
    attempt: (sandbox: boolean) => Promise<T>,
  ): Promise<SandboxedLaunch<T>> {
    const reason = sandboxFailureReason(err);
    const value = await attempt(false);
    // Only now is the sandbox known to be the cause: the same browser starts without it.
    this.record(target, { state: 'unavailable', reason });
    this.log.warn('sandbox fell back', {
      channel: target.channel,
      executable: target.executablePath,
      reason,
    });
    return { value, sandboxed: false };
  }

  private error(
    target: SandboxTarget,
    reason: string,
    requiredBy: SandboxRequirement,
    err?: unknown,
  ): AppError {
    return this.deps.unavailable({
      target,
      reason,
      requiredBy,
      workingChannels: this.workingChannels().filter((c) => c !== target.channel),
      ...(err !== undefined && { err }),
    });
  }
}

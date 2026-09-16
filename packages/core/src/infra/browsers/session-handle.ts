/** @module infra/browsers/session-handle — the launched session: crash listeners, identity replay, deadline-capped close that never throws. */

import type { Browser, BrowserContext, Page } from 'playwright';
import { withDeadline } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type {
  AppliedIdentity,
  EngineCapabilities,
  LaunchWarning,
  SessionHandle,
} from '../../ports/browser-driver.ts';
import type { Logger } from '../../ports/logger.ts';
import type { IdentityApplier } from './identity-applier.ts';
import type { PlaywrightTracingHandle } from './tracing.ts';

/** Everything the driver resolved for one session; the handle is a thin, final view over it. */
export interface SessionHandleInput {
  readonly sessionId: string;
  readonly browser: Browser | null;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright' | 'playwright';
  readonly identity: AppliedIdentity | null;
  readonly warnings: readonly LaunchWarning[];
  readonly tracing: PlaywrightTracingHandle | null;
  readonly applier: IdentityApplier | null;
  readonly logger: Logger;
}

/**
 * One browser process + one context, owned and torn down together. Crash detection subscribes to
 * `browser.on('disconnected')` and `context.on('close')`; both are silenced once `close()` starts
 * so an orderly teardown is never reported as a crash.
 */
export class PlaywrightSessionHandle implements SessionHandle {
  readonly sessionId: string;
  readonly browser: Browser | null;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright' | 'playwright';
  readonly identity: AppliedIdentity | null;
  readonly warnings: readonly LaunchWarning[];
  readonly tracing: PlaywrightTracingHandle | null;

  private readonly applier: IdentityApplier | null;
  private readonly logger: Logger;
  private readonly crashListeners = new Set<(reason: string) => void>();
  private closing = false;
  private closed: Promise<readonly LaunchWarning[]> | undefined;

  constructor(input: SessionHandleInput) {
    this.sessionId = input.sessionId;
    this.browser = input.browser;
    this.context = input.context;
    this.page = input.page;
    this.capabilities = input.capabilities;
    this.driver = input.driver;
    this.identity = input.identity;
    this.warnings = input.warnings;
    this.tracing = input.tracing;
    this.applier = input.applier;
    this.logger = input.logger.child({ module: 'browsers.session', sessionId: input.sessionId });

    this.browser?.on('disconnected', () => this.emitCrash('browser disconnected'));
    this.context.on('close', () => this.emitCrash('context closed'));
  }

  ensureIdentityForPage(page: Page): Promise<void> {
    return this.applier === null ? Promise.resolve() : this.applier.ensureForPage(page);
  }

  onCrash(listener: (reason: string) => void): () => void {
    this.crashListeners.add(listener);
    return () => {
      this.crashListeners.delete(listener);
    };
  }

  /**
   * Tear down all resources owned by this session within `deadlineMs`. Idempotent and best-effort:
   * each step is wrapped so a failure in `context.close()` does not skip `browser.close()`, and on
   * overrun the browser process is killed rather than awaited. Findings become warnings.
   */
  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]> {
    if (this.closed === undefined) this.closed = this.teardown(deadlineMs, signal);
    return this.closed;
  }

  private emitCrash(reason: string): void {
    if (this.closing) return;
    this.closing = true;
    this.logger.warn('browser exited early', { reason });
    for (const listener of this.crashListeners) {
      try {
        listener(reason);
      } catch (err) {
        this.logger.error('crash listener threw', { err: serializeError(err) });
      }
    }
  }

  private async teardown(
    deadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly LaunchWarning[]> {
    this.closing = true;
    const warnings: LaunchWarning[] = [];
    const deadline = withDeadline(signal, deadlineMs);
    const step = async (what: string, run: () => Promise<void>): Promise<boolean> => {
      if (deadline.signal.aborted) return false;
      try {
        await Promise.race([run(), rejectOnAbort(deadline.signal)]);
        return true;
      } catch (err) {
        if (deadline.signal.aborted) {
          this.logger.warn('close step timed out', { step: what, deadline_ms: deadlineMs });
          return false;
        }
        this.logger.debug('close step failed', { step: what, err: serializeError(err) });
        return true;
      }
    };
    try {
      // Detach the stealth CDP sessions first (harmless if the context is already tearing down).
      if (this.applier !== null)
        await step('identity', () => this.applier?.dispose() ?? Promise.resolve());
      if (this.tracing !== null) {
        const tracing = this.tracing;
        await step('tracing', async () => {
          const warning = await tracing.abandon();
          if (warning !== null) warnings.push(warning);
        });
      }
      await step('context', () => this.context.close());
      // For a `persistent` context `browser` is null; closing the context above is what tears down
      // the driver. For `memory`/`storage-state`, close the browser too.
      const browserClosed =
        this.browser === null
          ? true
          : await step('browser', () => this.browser?.close() ?? Promise.resolve());
      if (!browserClosed) this.killProcess();
    } finally {
      deadline.clear();
    }
    return warnings;
  }

  /** Last resort on overrun: the process, not the protocol, is what holds the resources. */
  private killProcess(): void {
    const browser = this.browser ?? this.context.browser();
    if (browser === null) return;
    try {
      // `Browser.process()` is not part of the public typings; probe for it structurally.
      const candidate: unknown = browser;
      if (typeof candidate !== 'object' || candidate === null || !('process' in candidate)) return;
      const processFn: unknown = candidate.process;
      if (typeof processFn !== 'function') return;
      const proc: unknown = processFn.call(candidate);
      if (typeof proc !== 'object' || proc === null || !('kill' in proc)) return;
      const kill: unknown = proc.kill;
      if (typeof kill !== 'function') return;
      kill.call(proc, 'SIGKILL');
      this.logger.warn('browser process killed', { reason: 'close deadline' });
    } catch (err) {
      this.logger.error('browser kill failed', { err: serializeError(err) });
    }
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

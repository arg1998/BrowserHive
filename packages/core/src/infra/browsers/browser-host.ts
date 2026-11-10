/** @module infra/browsers/browser-host — the exclusive `BrowserHost`: one browser and context, its page-attribution dispatcher, crash listeners, identity replay and a deadline-capped close that never throws. */

import type { Browser, BrowserContext, Page } from 'playwright';
import { withDeadline } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type {
  AppliedIdentity,
  BrowserHost,
  EngineCapabilities,
  LaunchWarning,
  SessionBrowserInfo,
} from '../../ports/browser-driver.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { IdentityApplier } from './identity-applier.ts';
import { sessionOwner } from './page-attribution.ts';
import { HostPageDispatcher } from './page-dispatcher.ts';
import type { PlaywrightTracingHandle } from './tracing.ts';

/** Everything the driver resolved for one exclusive session; the host is a thin, final wrapper over it. */
export interface BrowserHostInput {
  /** The session id: an exclusive host is named after its one session. */
  readonly sessionId: string;
  readonly browser: Browser | null;
  readonly context: BrowserContext;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright' | 'playwright';
  readonly identity: AppliedIdentity | null;
  readonly browserInfo: SessionBrowserInfo;
  readonly warnings: readonly LaunchWarning[];
  readonly tracing: PlaywrightTracingHandle | null;
  readonly applier: IdentityApplier | null;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * One browser process + one context of one exclusive session, owned and torn down together. Crash
 * detection subscribes to `browser.on('disconnected')` and `context.on('close')`; both are silenced
 * once `close()` starts so an orderly teardown is never reported as a crash. Every page of the
 * context, the ones present at launch and every later `page` event, goes through the host's
 * {@link HostPageDispatcher}, whose fallback owner is the session: an exclusive host parks nothing.
 */
export class PlaywrightBrowserHost implements BrowserHost {
  readonly hostId: string;
  readonly kind = 'exclusive' as const;
  readonly browser: Browser | null;
  readonly context: BrowserContext;
  readonly capabilities: EngineCapabilities;
  readonly driver: 'patchright' | 'playwright';
  readonly identity: AppliedIdentity | null;
  readonly browserInfo: SessionBrowserInfo;
  readonly warnings: readonly LaunchWarning[];
  readonly tracing: PlaywrightTracingHandle | null;
  /** Attributes the context's pages; read by the host's view. */
  readonly dispatcher: HostPageDispatcher;

  private readonly applier: IdentityApplier | null;
  private readonly logger: Logger;
  private readonly crashListeners = new Set<(reason: string) => void>();
  private closing = false;
  private closed: Promise<readonly LaunchWarning[]> | undefined;
  private pid: Promise<number | null> | undefined;

  constructor(input: BrowserHostInput) {
    this.hostId = input.sessionId;
    this.browser = input.browser;
    this.context = input.context;
    this.capabilities = input.capabilities;
    this.driver = input.driver;
    this.identity = input.identity;
    this.browserInfo = input.browserInfo;
    this.warnings = input.warnings;
    this.tracing = input.tracing;
    this.applier = input.applier;
    this.logger = input.logger.child({ module: 'browsers.session', sessionId: input.sessionId });
    this.dispatcher = new HostPageDispatcher({
      fallback: sessionOwner(input.sessionId),
      clock: input.clock,
      logger: this.logger,
    });

    this.browser?.on('disconnected', () => this.emitCrash('browser disconnected'));
    this.context.on('close', () => this.emitCrash('context closed'));
    // Registered after the identity applier's own `page` listener (it subscribed during launch),
    // so the override starts before the session's tab registry sees the page, as before the split.
    for (const page of this.context.pages()) this.dispatcher.adopt(page);
    this.context.on('page', (page) => this.dispatcher.adopt(page));
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
   * Tear down the browser and context within `deadlineMs`. Idempotent and best-effort:
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
    this.dispatcher.dispose();
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

  /**
   * The browser's main process id, from a browser-level DevTools session opened once
   * (`SystemInfo.getProcessInfo`); no page target is touched. Cached, including a `null`.
   */
  browserPid(): Promise<number | null> {
    this.pid ??= this.readBrowserPid();
    return this.pid;
  }

  private async readBrowserPid(): Promise<number | null> {
    const browser = this.browser ?? this.context.browser();
    if (browser === null || this.closing) return null;
    try {
      const cdp = await browser.newBrowserCDPSession();
      try {
        const info = await cdp.send('SystemInfo.getProcessInfo');
        return info.processInfo.find((p) => p.type === 'browser')?.id ?? null;
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch (err) {
      this.logger.debug('browser pid unavailable', { err: serializeError(err) });
      return null;
    }
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

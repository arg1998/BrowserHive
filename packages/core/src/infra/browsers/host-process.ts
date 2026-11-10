/** @module infra/browsers/host-process — the browser process behind a host: its pid (for the memory metric and the supervisor's sampler) and a last-resort kill when a close overruns its deadline. */

import type { Browser, BrowserContext } from 'playwright';
import { withDeadline } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';

/**
 * The browser's main process id, from a browser-level DevTools session (`SystemInfo.getProcessInfo`);
 * no page target is touched. `null` when it cannot be read.
 */
export async function readBrowserPid(
  browser: Browser | null,
  logger: Logger,
): Promise<number | null> {
  if (browser === null) return null;
  try {
    const cdp = await browser.newBrowserCDPSession();
    try {
      const info = await cdp.send('SystemInfo.getProcessInfo');
      return info.processInfo.find((p) => p.type === 'browser')?.id ?? null;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch (err) {
    logger.debug('browser pid unavailable', { err: serializeError(err) });
    return null;
  }
}

/** Last resort on overrun: the process, not the protocol, is what holds the resources. */
export function killBrowserProcess(browser: Browser | null, logger: Logger): void {
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
    logger.warn('browser process killed', { reason: 'close deadline' });
  } catch (err) {
    logger.error('browser kill failed', { err: serializeError(err) });
  }
}

/** Rejects with the signal's reason once it aborts. */
export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * Closes a persistent context (and so its browser) within `deadlineMs`; on overrun the browser
 * process is killed. Never throws.
 */
export async function closeContextWithin(
  context: BrowserContext,
  browser: Browser | null,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  logger: Logger,
): Promise<void> {
  const deadline = withDeadline(signal, deadlineMs);
  try {
    await Promise.race([context.close(), rejectOnAbort(deadline.signal)]);
  } catch (err) {
    if (deadline.signal.aborted) {
      logger.warn('host close timed out', { deadline_ms: deadlineMs });
      killBrowserProcess(browser, logger);
    } else {
      logger.debug('host close failed', { err: serializeError(err) });
    }
  } finally {
    deadline.clear();
  }
}

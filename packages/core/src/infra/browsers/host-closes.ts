/** @module infra/browsers/host-closes — how a template host tells that the operator quit its browser (spec 13 §3.2, D-78): the host starts with no window and Chromium keeps it running with none, so quitting is read from the windows themselves: the host's last page target destroyed by Chromium, not closed by BrowserHive. */

import type { Page } from 'patchright';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';

/**
 * Pages closed in the browser within this long of each other are one operator action: the menu's
 * **Exit** closes every window at once, a window holding several tabs closes them together.
 */
export const CLOSE_BURST_MS = 1_000;

/** What the watch needs from its host. */
export interface CloseWatchHost {
  readonly clock: Clock;
  readonly log: Logger;
  /** The host is closing (BrowserHive's own close, or a crash): nothing is decided. */
  closing(): boolean;
  /** Page targets Chromium has not destroyed yet (windows being created count). */
  livePageCount(): number;
  /** True when BrowserHive closed this target through its own browser session. */
  closedByHost(targetId: string): boolean;
  /**
   * The adopted page of a target and whether it belonged to a recording or re-login session;
   * `undefined` for a target no page of the host was read for (Playwright's own storage page).
   */
  pageOf(targetId: string): { readonly page: Page; readonly maintenance: boolean } | undefined;
  /** The operator quit the browser: called once. */
  operatorStop(reason: string): void;
}

/**
 * True when BrowserHive (or anything holding the page object) called `page.close()`: Playwright
 * marks the page before it asks Chromium to close it (`Page._closeWasCalled`, Patchright 1.63; a
 * driver without the field makes every close look like the operator's, which the integration
 * test "closing the last session's window keeps the browser running" would catch).
 */
export function closeWasCalled(page: Page): boolean {
  return Reflect.get(page, '_closeWasCalled') === true;
}

/**
 * Watches a host's destroyed page targets. A target Chromium destroys is an **operator close**
 * when BrowserHive did not close it: no `page.close()` on its page and no `Target.closeTarget` of
 * the host's session. A killed browser destroys nothing (its pipe just closes), so a crash never
 * looks like this, and a page cannot fake it: Chrome refuses `window.close()` in a window
 * BrowserHive created (measured).
 *
 * The host's **last** page target destroyed by an operator close is an operator stop (the window
 * closed by hand, taskbar Close, the menu's Exit, macOS Cmd+Q with a window open), unless every
 * page the operator closed in that burst belonged to a recording or re-login session: closing the
 * sign-in window after signing in is not quitting the browser, and the sign-in still needs it
 * (**I'm signed in**, Finish). The host then stays up with no window, as Chromium keeps it.
 */
export class OperatorCloseWatch {
  private readonly host: CloseWatchHost;
  private burst: { at: number; quits: boolean } | null = null;
  private fired = false;

  constructor(host: CloseWatchHost) {
    this.host = host;
  }

  /** Chromium reported the page target `targetId` destroyed. */
  targetDestroyed(targetId: string): void {
    const { host } = this;
    if (this.fired || host.closing() || host.closedByHost(targetId)) return;
    const known = host.pageOf(targetId);
    if (known === undefined || closeWasCalled(known.page)) return;
    const now = host.clock.now();
    if (this.burst === null || now - this.burst.at > CLOSE_BURST_MS) {
      this.burst = { at: now, quits: false };
    }
    this.burst.at = now;
    this.burst.quits ||= !known.maintenance;
    if (host.livePageCount() > 0) return;
    if (!this.burst.quits) {
      // The browser stays up with no window (Chromium keeps it).
      host.log.info('sign-in window closed', { by: 'operator' });
      return;
    }
    this.fired = true;
    host.operatorStop('the last window was closed in the browser');
  }

  /** True once an operator stop was reported. */
  get stopped(): boolean {
    return this.fired;
  }
}

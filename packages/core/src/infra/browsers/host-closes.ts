/** @module infra/browsers/host-closes — how a template host tells that the operator quit its browser (spec 13 §3.2, D-78): the host starts with no window and Chromium keeps it running with none, so quitting is read from the windows themselves: the host's last page target destroyed by Chromium, not closed by BrowserHive. */

import type { Page } from 'patchright';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';

/**
 * An operator close this recent, with no page adopted since, makes the host's last page going away
 * an operator stop: the menu's **Exit** closes every window at once, a window holding several tabs
 * closes them together, and a `close_tab` or a checkpoint's storage page may close just after.
 */
export const OPERATOR_CLOSE_WINDOW_MS = 2_000;

/** How a host was left with no page target, when it was not an operator stop. */
export type ZeroWindows =
  /** The operator closed only recording or re-login windows: the sign-in goes on. */
  | 'sign_in_closed'
  /** BrowserHive's own close, a page that closed itself, or Playwright's storage page. */
  | 'other';

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
   * The adopted page of a target, whether it belonged to a recording or re-login session, and
   * whether a page opened it (a popup, a site's tab); `undefined` for a target no page of the host
   * was read for (Playwright's own storage page).
   */
  pageOf(
    targetId: string,
  ): { readonly page: Page; readonly maintenance: boolean; readonly opened: boolean } | undefined;
  /** The operator quit the browser: called once. */
  operatorStop(reason: string): void;
  /** The host has no page left and is not stopping (Chrome dropped its session cookies). */
  zeroWindows(kind: ZeroWindows): void;
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
 * when BrowserHive did not close it (no `page.close()` on its page, no `Target.closeTarget` of the
 * host's session) and no page opened it: a popup or a tab a site opened may close itself
 * (`window.close()`), so it never counts as the operator's (review #91 M1). A window BrowserHive
 * created refuses `window.close()` (measured), and a killed browser destroys nothing (its pipe just
 * closes), so neither a page nor a crash can look like an operator close.
 *
 * When the host is left with no page target (any destroy: the operator's, BrowserHive's own, a
 * storage page's), it is an **operator stop** if the operator closed a window within the last
 * {@link OPERATOR_CLOSE_WINDOW_MS} and no page was adopted since (so a `close_tab` or a checkpoint
 * racing the operator's close of the last window does not hide it, review #91 L1), unless every
 * window the operator closed then belonged to a recording or re-login session: closing the sign-in
 * window is not quitting the browser, and the sign-in still needs it. Otherwise the host is told it
 * has no window left ({@link CloseWatchHost.zeroWindows}).
 */
export class OperatorCloseWatch {
  private readonly host: CloseWatchHost;
  /** Operator closes since the last adopted page: when, and whether one was not a sign-in window. */
  private closes: { at: number; quits: boolean } | null = null;
  private fired = false;

  constructor(host: CloseWatchHost) {
    this.host = host;
  }

  /** A page was adopted: an earlier operator close no longer means the operator quit. */
  pageAdopted(): void {
    this.closes = null;
  }

  /** Chromium reported the page target `targetId` destroyed. */
  targetDestroyed(targetId: string): void {
    const { host } = this;
    if (this.fired || host.closing()) return;
    const now = host.clock.now();
    const known = host.pageOf(targetId);
    const operator =
      known !== undefined &&
      !known.opened &&
      !host.closedByHost(targetId) &&
      !closeWasCalled(known.page);
    if (operator) {
      const quits = !known.maintenance;
      this.closes =
        this.closes === null || now - this.closes.at > OPERATOR_CLOSE_WINDOW_MS
          ? { at: now, quits }
          : { at: now, quits: this.closes.quits || quits };
    }
    if (host.livePageCount() > 0) return;
    const recent = this.closes !== null && now - this.closes.at <= OPERATOR_CLOSE_WINDOW_MS;
    if (recent && this.closes?.quits === true) {
      this.fired = true;
      host.operatorStop('the last window was closed in the browser');
      return;
    }
    if (recent) host.log.info('sign-in window closed', { by: 'operator' });
    host.zeroWindows(recent ? 'sign_in_closed' : 'other');
  }

  /** True once an operator stop was reported. */
  get stopped(): boolean {
    return this.fired;
  }
}

/** @module app/sessions/scheme-guard — the non-web scheme backstop: closes a session page whose main frame commits a URL outside the web schemes (spec 13 T0d, D-57). */

import type { Frame, Page } from 'playwright';
import { refusedCommittedScheme, type SchemeOptions } from '../../domain/policies/url-scheme.ts';
import type { TabRegistry } from '../../domain/session/tabs.ts';
import type { Logger } from '../../ports/logger.ts';

/** Every session is exclusive today, so its pages may show `data:` documents. */
const SESSION_SCHEME_OPTIONS: SchemeOptions = { allowData: true };

/** How long a close may take before it is sent again over CDP, and how many times. */
const CLOSE_WAIT_MS = 1_000;
const CLOSE_RETRIES = 3;

/** Resolves after `ms`, or as soon as `page` closes. */
function closedWithin(page: Page, ms: number): Promise<void> {
  if (page.isClosed()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      page.off('close', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    page.once('close', done);
  });
}

/**
 * Closes `page`. The close runs on a later macrotask, never inside the `framenavigated` turn.
 * Chromium sometimes drops a close sent while the main frame is still committing (measured on a
 * `file:` commit: about one in ten), and Playwright never re-sends one, so a page still open after
 * {@link CLOSE_WAIT_MS} is closed again with CDP `Page.close`. Resolves `true` once it is closed.
 */
async function closePage(page: Page): Promise<boolean> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  page.close().catch(() => undefined);
  for (let retry = 0; retry < CLOSE_RETRIES; retry++) {
    await closedWithin(page, CLOSE_WAIT_MS);
    if (page.isClosed()) return true;
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Page.close');
    } catch {
      // The page closed (or the context went away) in the meantime; the loop re-checks.
    }
  }
  await closedWithin(page, CLOSE_WAIT_MS);
  return page.isClosed();
}

/** What the guard needs from the session that owns the page. */
export interface SchemeGuardTarget {
  readonly sessionId: string;
  readonly tabs: TabRegistry;
  readonly logger: Logger;
}

/**
 * Watches `page` for main-frame commits. The `urlScheme` tool policy stops agents from asking for
 * a non-web URL; this catches navigations no tool requested (a site, a popup, a driver quirk). When
 * the main frame commits a URL outside `http:`, `https:`, `about:blank`/`about:srcdoc`, `blob:`,
 * `chrome-error:` and `data:`, the page's tab is removed, the page closed and
 * `non-web scheme page closed` logged with the session id and scheme. A page already showing such
 * a URL when the guard attaches is closed at once. Pages without an event emitter (unit fakes) are
 * left alone.
 */
export function guardPageScheme(page: Page, target: SchemeGuardTarget): void {
  const emitter: { on?: unknown } = page;
  if (typeof emitter.on !== 'function') return;
  let closing = false;
  const check = (url: string): void => {
    // A page that has not committed anything yet reports an empty URL.
    if (closing || url === '') return;
    const scheme = refusedCommittedScheme(url, SESSION_SCHEME_OPTIONS);
    if (scheme === null) return;
    closing = true;
    const tabId = target.tabs.idFor(page);
    if (tabId !== undefined) target.tabs.remove(tabId);
    target.logger.warn('non-web scheme page closed', {
      sessionId: target.sessionId,
      ...(tabId !== undefined && { tabId }),
      scheme,
    });
    void closePage(page).then((closed) => {
      if (!closed) {
        target.logger.error('scheme page close failed', {
          sessionId: target.sessionId,
          scheme,
        });
      }
    });
  };
  page.on('framenavigated', (frame: Frame) => {
    if (frame.parentFrame() !== null) return;
    check(frame.url());
  });
  check(page.url());
}

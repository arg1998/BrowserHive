/** @module infra/browsers/focus-emulation — the `PageFocusControl` port over a second DevTools session per page (spec 13 §3.10, §9.4 `single-focus`). */

import type { CDPSession, Page } from 'patchright';
import { z } from 'zod';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { PageFocusControl } from '../../ports/page-focus.ts';

/*
 * Measured on Patchright 1.63 (Chromium 1243, new headless, Linux; T3b WP-B):
 * - The driver's own page session sends `Emulation.setFocusEmulationEnabled {enabled: true}` for
 *   every page (unless the context's internal `focusControl` option is set, which hosts do not use).
 * - A second session (`context.newCDPSession(page)`) sending `{enabled: false}` turns the page's
 *   focus emulation off in the renderer (last writer wins): `document.hasFocus()` answers the real
 *   focus and the page gets a `blur` event; `{enabled: true}` turns it back on with a `focus` event.
 * - `visibilityState` stays `visible`: the browser-side capture count the driver's session holds is
 *   not released by another session. Screenshots (Playwright and `Page.captureScreenshot`) work.
 * - Every new document (a navigation, same-origin or not, a reload, a script navigation) is focused
 *   again: the renderer restores the driver session's emulation state for it. The off state is
 *   re-sent at the main frame's `framenavigated`, so the new document's first scripts can still
 *   read `hasFocus() === true` for about 15 ms, then get a `blur`.
 * - Headless, a window is really focused once it got input (a click) and never loses it: activating
 *   another window does not deactivate it. Minimizing the window (`Browser.setWindowBounds` on the
 *   page's own session) deactivates it without the page noticing anything but the `blur`: it stays
 *   `visible`, keeps its sizes and screen position, runs `requestAnimationFrame` at 60/s and
 *   screenshots in about 60 ms; restoring it (`normal`) activates it again. Headed windows are left
 *   to the window manager (the operator's own window holds the real focus).
 */

const WindowForTarget = z.object({ windowId: z.number().int() });

/** Every call this control makes is bounded: a stuck call must never hold an agent's tool. */
export const FOCUS_CALL_MS = 2_000;

/**
 * Minimizing to release a headless window's real focus was measured on Linux only; on macOS the
 * call stalled and on Windows it did not release the focus (T3b CI), so it is skipped there.
 */
export const MINIMIZE_RELEASES_FOCUS = process.platform === 'linux';

/** `promise`, or a rejection after {@link FOCUS_CALL_MS}. */
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('focus call timed out')), FOCUS_CALL_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

interface Entry {
  readonly session: Promise<CDPSession | null>;
  emulated: boolean;
  /** The window this control minimized for the page (headless), else `null`. */
  minimized: number | null;
}

/** The production {@link PageFocusControl}. */
export class CdpPageFocus implements PageFocusControl {
  readonly #entries = new Map<Page, Entry>();
  readonly #log: Logger;
  readonly #minimizes: boolean;

  /** `minimizes`: release a headless window's real focus by minimizing it (Linux, measured). */
  constructor(logger: Logger, minimizes: boolean = MINIMIZE_RELEASES_FOCUS) {
    this.#log = logger.child({ module: 'browsers.focus' });
    this.#minimizes = minimizes;
  }

  async setEmulated(page: Page, emulated: boolean, headless: boolean): Promise<void> {
    let entry = this.#entries.get(page);
    // Never touched: the driver's default (emulated) is in force.
    if (entry === undefined && emulated) return;
    if (entry === undefined) {
      entry = { session: this.#attach(page), emulated, minimized: null };
      this.#entries.set(page, entry);
    } else if (entry.emulated === emulated) {
      return;
    }
    entry.emulated = emulated;
    await this.#send(entry, emulated);
    if (!emulated && headless && this.#minimizes) await this.#minimize(entry);
    if (emulated) await this.#restore(entry);
  }

  async #attach(page: Page): Promise<CDPSession | null> {
    if (page.isClosed()) return null;
    try {
      const session = await bounded(page.context().newCDPSession(page));
      // A new document is focused again (see above): the off state is sent once more.
      page.on('framenavigated', (frame) => {
        const entry = this.#entries.get(page);
        if (frame === page.mainFrame() && entry !== undefined && !entry.emulated) {
          void this.#send(entry, false);
        }
      });
      page.once('close', () => {
        const entry = this.#entries.get(page);
        this.#entries.delete(page);
        if (entry !== undefined) void this.#restore(entry);
        void session.detach().catch(() => undefined);
      });
      return session;
    } catch (err) {
      this.#log.debug('focus session not attached', { err: serializeError(err) });
      return null;
    }
  }

  async #send(entry: Entry, enabled: boolean): Promise<void> {
    const session = await entry.session;
    if (session === null) return;
    try {
      await bounded(session.send('Emulation.setFocusEmulationEnabled', { enabled }));
    } catch (err) {
      // The page closed or crashed meanwhile.
      this.#log.debug('focus emulation not set', { enabled, err: serializeError(err) });
    }
  }

  /** Deactivates the page's window (headless only, see above). */
  async #minimize(entry: Entry): Promise<void> {
    const session = await entry.session;
    if (session === null || entry.minimized !== null) return;
    try {
      const { windowId } = WindowForTarget.parse(
        await bounded(session.send('Browser.getWindowForTarget')),
      );
      await bounded(
        session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }),
      );
      entry.minimized = windowId;
    } catch (err) {
      this.#log.debug('window not minimized', { err: serializeError(err) });
    }
  }

  /** Restores a window this control minimized once none of its unfocused pages is left. */
  async #restore(entry: Entry): Promise<void> {
    const windowId = entry.minimized;
    entry.minimized = null;
    if (windowId === null) return;
    for (const other of this.#entries.values()) {
      if (other.minimized === windowId && !other.emulated) return;
    }
    const session = await entry.session;
    if (session === null) return;
    try {
      await bounded(
        session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }),
      );
    } catch (err) {
      this.#log.debug('window not restored', { err: serializeError(err) });
    }
  }
}

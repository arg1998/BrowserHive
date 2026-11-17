/** @module ports/page-focus — focus emulation of one page of a template host (spec 13 §3.10, §9.4 `single-focus`): the driver keeps every page focused and visible; the `single-focus` strategy turns that off for a site's pages other than the one acted on last. */

import type { Page } from './page-types.ts';

/** Turns a page's focus emulation off and on again. */
export interface PageFocusControl {
  /**
   * `false`: the page stops emulating focus and reports its real focus (`document.hasFocus()`,
   * `focus`/`blur` events), also after later navigations of the page, until set back to `true`.
   * `true` restores the driver's default. On a `headless` host the real focus of a window sticks
   * once it got input, so the window is also deactivated (and reactivated with `true`); a headed
   * host's windows are never touched (spec 13 §3.3). Idempotent; a closed page is ignored; never
   * throws.
   */
  setEmulated(page: Page, emulated: boolean, headless: boolean): Promise<void>;
}

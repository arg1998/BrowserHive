/** @module interface/mcp/tools/inspection/content — reads the tab's HTML, waiting out a navigation in flight once (#55). */

import { isAppError } from '../../../../kernel/errors/app-error.ts';
import type { Page } from '../../../../ports/page-types.ts';
import type { ToolCallContext } from '../../context.ts';
import { drive, registryError } from '../shared.ts';

/** How long a read waits for an in-flight navigation to settle before giving up. */
export const SETTLE_BUDGET_MS = 5_000;

/** The `what` of the `WAIT_TIMEOUT` (the classifier's navigating row uses the same words). */
const NAVIGATING_WHAT = 'the page to finish navigating';

const BUDGET_SPENT: unique symbol = Symbol('budget spent');
const REFUSED: unique symbol = Symbol('refused while navigating');

/**
 * `page.content()`, tolerant of a navigation in flight. Measured on Playwright 1.63, a read issued
 * while a navigation is pending blocks until the new document commits and is then refused
 * (`content: Unable to retrieve content because the page is navigating…`, which the classifier maps
 * to `WAIT_TIMEOUT`). So the read is bounded by {@link SETTLE_BUDGET_MS}; on the refusal this waits
 * for `domcontentloaded` and reads once more, again within the budget. A read that does not answer
 * in time, or a second refusal, answers `WAIT_TIMEOUT` with `what: 'the page to finish navigating'`
 * (retryable with backoff). Any other failure is classified as usual.
 */
export async function contentWhenSettled(
  ctx: ToolCallContext,
  page: Page,
  sessionId: string,
): Promise<string> {
  const read = (): Promise<string> =>
    drive(ctx, { sessionId, what: 'page content', timeoutMs: SETTLE_BUDGET_MS }, () =>
      page.content(),
    );
  let first: string | typeof BUDGET_SPENT | typeof REFUSED;
  try {
    first = await withinBudget(ctx, read());
  } catch (err) {
    // `content()` takes no timeout, so a WAIT_TIMEOUT from it can only be the navigating refusal.
    if (!isAppError(err) || err.code !== 'WAIT_TIMEOUT') throw err;
    first = REFUSED;
  }
  if (first === BUDGET_SPENT) throw stillNavigating();
  if (first !== REFUSED) return first;
  const settled = async (): Promise<string> => {
    await page
      .waitForLoadState('domcontentloaded', { timeout: SETTLE_BUDGET_MS })
      .catch(() => undefined);
    return read();
  };
  const html = await withinBudget(ctx, settled());
  if (html === BUDGET_SPENT) throw stillNavigating();
  return html;
}

/**
 * `work`, or {@link BUDGET_SPENT} once {@link SETTLE_BUDGET_MS} passes first. Playwright's own
 * timeouts do not bound a read mid-navigation, so the clock does; the driver call keeps running and
 * its late outcome is dropped.
 */
async function withinBudget<T>(
  ctx: ToolCallContext,
  work: Promise<T>,
): Promise<T | typeof BUDGET_SPENT> {
  const budget = new AbortController();
  const spentAt = (): typeof BUDGET_SPENT => BUDGET_SPENT;
  const spent = ctx.services.clock.sleep(SETTLE_BUDGET_MS, budget.signal).then(spentAt, spentAt);
  try {
    const winner = await Promise.race([work, spent]);
    if (winner === BUDGET_SPENT) work.catch(() => undefined);
    return winner;
  } finally {
    budget.abort();
  }
}

function stillNavigating() {
  return registryError('WAIT_TIMEOUT', { what: NAVIGATING_WHAT, timeout_ms: SETTLE_BUDGET_MS });
}

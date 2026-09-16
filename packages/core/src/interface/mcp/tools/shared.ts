/** @module interface/mcp/tools/shared — helpers every tool pack uses: page resolution, driver-error mapping, navigation facts. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import type { Page } from 'playwright';
import type { Session } from '../../../domain/session/session.ts';
import { AppError, isAppError } from '../../../kernel/errors/app-error.ts';
import type { DriverErrorContext } from '../../../ports/page-actions.ts';
import type { ToolCallContext } from '../context.ts';
import type { PageVisit } from '../definition.ts';

/** The page for `tabId`, or the active tab. @throws `TAB_NOT_FOUND` */
export function pageOf(ctx: ToolCallContext, session: Session, tabId?: string): Page {
  return ctx.services.sessions.page(session, tabId);
}

/** `page.url()` that never throws (a closed page answers `about:blank`). */
export function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    // Target closed: report a neutral URL rather than failing a successful call.
    return 'about:blank';
  }
}

/** First line of a message, trimmed and capped (the detail appended to typed errors). */
export function firstLine(err: unknown, max = 160): string {
  const message = err instanceof Error ? err.message : 'unknown error';
  return message.split('\n')[0]?.trim().slice(0, max) ?? '';
}

/** Builds an `AppError` whose public message is the registry template rendered from `details`. */
export function registryError<C extends keyof typeof ERROR_REGISTRY>(
  code: C,
  details: ConstructorParameters<typeof AppError<C>>[1],
  cause?: unknown,
): AppError<C> {
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(details));
  return new AppError(code, details, {
    publicMessage: renderMessage(ERROR_REGISTRY[code].message, record),
    ...(cause !== undefined && { cause }),
  });
}

/**
 * Runs a driver call and maps a Playwright failure onto a registry code through the classifier
 * (unknown prose is rethrown and becomes `INTERNAL_ERROR` with a private cause).
 */
export async function drive<T>(
  ctx: ToolCallContext,
  context: DriverErrorContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isAppError(err)) throw err;
    const classified = ctx.services.pageActions.classifyError(err, context);
    if (classified !== null) throw classified;
    throw err;
  }
}

/**
 * Navigation calls: timeouts are `NAVIGATION_TIMEOUT` regardless of which history API timed out;
 * everything else goes through the classifier.
 */
export async function navigation<T>(
  ctx: ToolCallContext,
  session: Session,
  target: { readonly url: string; readonly timeoutMs: number; readonly tabId?: string | undefined },
  run: () => Promise<T>,
): Promise<T> {
  const context: DriverErrorContext = {
    url: target.url,
    timeoutMs: target.timeoutMs,
    sessionId: session.id,
    ...(target.tabId !== undefined && { tabId: target.tabId }),
  };
  try {
    return await run();
  } catch (err) {
    if (isAppError(err)) throw err;
    const classified = ctx.services.pageActions.classifyError(err, context);
    const timedOut =
      (err instanceof Error && err.name === 'TimeoutError') || classified?.code === 'WAIT_TIMEOUT';
    if (timedOut && classified?.code !== 'NAVIGATION_FAILED') {
      throw registryError(
        'NAVIGATION_TIMEOUT',
        { url: target.url, timeout_ms: target.timeoutMs },
        err,
      );
    }
    if (classified !== null) throw classified;
    throw err;
  }
}

/**
 * Records a completed navigation: bumps `navigation_count`, stamps the session URL (publishes
 * `session.updated`), closes vault redaction windows that left their origin, and returns the page
 * visit the dispatcher publishes after `tool.called`.
 */
export async function recordNavigation(
  ctx: ToolCallContext,
  session: Session,
  page: Page,
): Promise<PageVisit> {
  session.bump('navigations');
  const url = safeUrl(page);
  ctx.services.sessions.setCurrentUrl(session, url);
  ctx.services.redaction.onNavigation(session.id, url);
  const title = await page.title().catch(() => null);
  const tabId = session.tabs.idFor(page) ?? session.tabs.activeTabId() ?? '';
  return { sessionId: session.id, tabId, url, title };
}

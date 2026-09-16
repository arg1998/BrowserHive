/** @module app/sessions/session-tabs — tab operations over a live session (new/close/switch/list) with identity replay and audit-safe titles. */

import type { Page } from 'playwright';
import type { Session } from '../../domain/session/session.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';

/** One `list_tabs` row. */
export interface TabInfo {
  readonly tabId: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
}

/** Collaborators of {@link SessionTabs}. */
export interface SessionTabsDeps {
  readonly clock: Clock;
  readonly logger: Logger;
}

/** Tab operations. Every method takes an already-authorized session (from `SessionService.get`). */
export class SessionTabs {
  constructor(private readonly deps: SessionTabsDeps) {}

  /**
   * Opens a new page, waits for the per-page identity override (so the first request already
   * carries it), registers it and makes it active (the `new_tab` tool).
   */
  async newTab(session: Session): Promise<{ tabId: string; page: Page }> {
    const handle = session.handle;
    if (handle === null) {
      throw new AppError(
        'SESSION_NOT_LIVE',
        { session_id: session.id },
        { publicMessage: `Session '${session.id}' is not live.` },
      );
    }
    const page = await handle.context.newPage();
    await handle.ensureIdentityForPage(page);
    const tabId = session.tabs.add(page);
    session.tabs.setActive(tabId);
    session.setCurrentUrl(safeUrl(page), this.deps.clock.now());
    return { tabId, page };
  }

  /** Closes a page and forgets its tab. @throws `TAB_NOT_FOUND`. */
  async closeTab(session: Session, tabId: string): Promise<void> {
    const page = session.tabs.resolve(tabId);
    session.tabs.remove(tabId);
    try {
      await page.close();
    } catch (err) {
      this.deps.logger.debug('tab close failed', {
        sessionId: session.id,
        tabId,
        err: serializeError(err),
      });
    }
  }

  /** Makes `tabId` active. @throws `TAB_NOT_FOUND`. */
  switchTab(session: Session, tabId: string): Page {
    const page = session.tabs.setActive(tabId);
    session.setCurrentUrl(safeUrl(page), this.deps.clock.now());
    return page;
  }

  /** `list_tabs` rows in insertion order; a title that cannot be read is `''`. */
  async listTabs(session: Session): Promise<readonly TabInfo[]> {
    const active = session.tabs.activeTabId();
    const rows: TabInfo[] = [];
    for (const [tabId, page] of session.tabs.entries()) {
      let title = '';
      try {
        title = await page.title();
      } catch {
        title = '';
      }
      rows.push({ tabId, url: safeUrl(page) ?? '', title, active: tabId === active });
    }
    return rows;
  }
}

function safeUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}

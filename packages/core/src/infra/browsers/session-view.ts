/** @module infra/browsers/session-view — the `SessionView` of an exclusive host: its one session sees every page of the context, and closing the view closes the host. */

import type { CDPSession, Page } from 'playwright';
import { AppError } from '../../kernel/errors/app-error.ts';
import type {
  Cookie,
  CookieInput,
  LaunchWarning,
  SessionView,
  StorageStateSource,
} from '../../ports/browser-driver.ts';
import type { PlaywrightBrowserHost } from './browser-host.ts';

/**
 * The one view over an exclusive {@link PlaywrightBrowserHost}. Pages come from the host's
 * attribution dispatcher (whose fallback owner is this session, so every page of the context is
 * this session's); cookies, extra headers and the storage state are context-wide, which is exact
 * for a context nobody else uses.
 */
export class ExclusiveSessionView implements SessionView {
  readonly sessionId: string;
  readonly host: PlaywrightBrowserHost;
  readonly page: Page;
  private readonly profileDir: string | null;

  /**
   * @param host The exclusive host (its `hostId` is the session id).
   * @param page The first page.
   * @param userDataDir The managed profile directory of a `persistent` session, else `null`.
   */
  constructor(host: PlaywrightBrowserHost, page: Page, userDataDir: string | null) {
    this.sessionId = host.hostId;
    this.host = host;
    this.page = page;
    this.profileDir = userDataDir;
  }

  pages(): readonly Page[] {
    return this.host.dispatcher.pagesOf(this.sessionId);
  }

  owns(page: Page): boolean {
    const owner = this.host.dispatcher.ownerOf(page);
    return owner?.kind === 'session' && owner.sessionId === this.sessionId;
  }

  onPage(listener: (page: Page) => void): () => void {
    return this.host.dispatcher.onAttributed(this.sessionId, listener);
  }

  newPage(): Promise<Page> {
    // The context's `page` event attributes it (to this session) before `newPage()` resolves.
    return this.host.context.newPage();
  }

  cookies(urls?: readonly string[]): Promise<Cookie[]> {
    const context = this.host.context;
    return urls !== undefined ? context.cookies(urls) : context.cookies();
  }

  addCookies(cookies: readonly CookieInput[]): Promise<void> {
    return this.host.context.addCookies(cookies);
  }

  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    return this.host.context.setExtraHTTPHeaders(headers);
  }

  storageStateSource(): StorageStateSource {
    return this.host.context;
  }

  userDataDir(): string | null {
    return this.profileDir;
  }

  newCDPSession(page: Page): Promise<CDPSession> {
    if (!this.host.dispatcher.everOwnedBy(page, this.sessionId)) {
      return Promise.reject(notOwned(this.sessionId));
    }
    return this.host.context.newCDPSession(page);
  }

  onCrash(listener: (reason: string) => void): () => void {
    return this.host.onCrash(listener);
  }

  close(deadlineMs: number, signal?: AbortSignal): Promise<readonly LaunchWarning[]> {
    return this.host.close(deadlineMs, signal);
  }
}

/** The page belongs to another session (or none): an isolation bug, never a user error. */
function notOwned(sessionId: string): AppError<'INTERNAL_ERROR'> {
  return new AppError(
    'INTERNAL_ERROR',
    { ref: 'page-not-owned' },
    { message: `page is not attributed to session ${sessionId}` },
  );
}

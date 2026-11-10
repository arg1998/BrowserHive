/** @module infra/browsers/template-host-ops — operator operations on a running template host (spec 13 §2.3, §3.3, §3.4): removing a domain's sign-in, minimizing agent windows while a recording is open, and the windows several sessions share. */

import type { BrowserContext, CDPSession, Page } from 'playwright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { Logger } from '../../ports/logger.ts';
import type { SharedWindowInfo, SignInRemoval } from '../../ports/template-host.ts';
import type { HostPageDispatcher } from './page-dispatcher.ts';
import { profileOrigins } from './profile-origins.ts';
import type { HostTargets } from './template-targets.ts';

/** What the operations read from a host. */
export interface HostOpsTarget {
  readonly context: BrowserContext;
  readonly dispatcher: HostPageDispatcher;
  readonly targets: HostTargets;
}

/** One session's pages, as the host knows them. */
export interface ViewPages {
  readonly sessionId: string;
  readonly maintenance: boolean;
  pages(): readonly Page[];
}

/** Escapes `text` for a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The cookie's host without its leading dot. */
function cookieHost(domain: string): string {
  return domain.replace(/^\./, '');
}

/** What removing a sign-in needs beyond {@link HostOpsTarget}. */
export interface SignInHost extends HostOpsTarget {
  /** Origins the browser committed (every frame) since it started. */
  readonly committedOrigins: ReadonlySet<string>;
  /** The profile directory (origins stored by earlier starts); `null` = not scanned. */
  readonly userDataDir: string | null;
  /** A page-target DevTools session of the host (`Storage.*` needs a storage partition). */
  storageSession(): Promise<CDPSession>;
  readonly log: Logger;
}

function originSite(origin: string): string {
  try {
    return registrableDomain(new URL(origin).hostname);
  } catch {
    return '';
  }
}

/**
 * Removes the sign-in of `domain` (a registrable domain) from the host (spec 13 §2.3 **Remove
 * sign-in**): every cookie on it or a subdomain, and the site data (local and session storage,
 * IndexedDB, service workers, Cache Storage, …) of every origin under it that the browser
 * committed, a cookie names, or the profile holds data for. Origins whose data could not be cleared
 * are logged as a warning and reported, never dropped.
 */
export async function clearSignIn(host: SignInHost, domain: string): Promise<SignInRemoval> {
  const cookies = await host.context.cookies();
  const matching = cookies.filter((c) => registrableDomain(cookieHost(c.domain)) === domain);
  const hosts = [domain, `www.${domain}`, ...matching.map((c) => cookieHost(c.domain))];
  const candidates = new Set([
    ...hosts.flatMap((h) => [`https://${h}`, `http://${h}`]),
    ...host.committedOrigins,
    ...(host.userDataDir === null ? [] : await profileOrigins(host.userDataDir)),
  ]);
  const origins = [...candidates].filter((o) => originSite(o) === domain).sort();
  const uncleared: string[] = [];
  let cdp: CDPSession | null = null;
  try {
    cdp = await host.storageSession();
    for (const origin of origins) {
      try {
        await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
      } catch (err) {
        host.log.warn('site data not cleared', { origin, err: serializeError(err) });
        uncleared.push(origin);
      }
    }
  } catch (err) {
    host.log.warn('site data not cleared', { domain, err: serializeError(err) });
    uncleared.splice(0, uncleared.length, ...origins);
  } finally {
    await cdp?.detach().catch(() => undefined);
  }
  await host.context.clearCookies({ domain: new RegExp(`(^|\\.)${escapeRegExp(domain)}$`) });
  return {
    cookiesRemoved: matching.length,
    origins: origins.filter((o) => !uncleared.includes(o)),
    unclearedOrigins: uncleared,
  };
}

/** The distinct windows that hold `pages` (unreadable ones skipped). */
async function windowsOf(host: HostOpsTarget, pages: readonly Page[]): Promise<Set<number>> {
  const windows = new Set<number>();
  for (const page of pages) {
    const targetId = host.dispatcher.targetIdOf(page);
    if (targetId === undefined) continue;
    const windowId = await host.targets.windowOf(targetId);
    if (windowId !== null) windows.add(windowId);
  }
  return windows;
}

/**
 * Minimizes every window that shows an agent session's page (spec 13 §3.3: while a recording or
 * re-login window is open, agent windows are minimized). Never raises or moves a window.
 */
export async function minimizeAgentWindows(
  host: HostOpsTarget,
  views: Iterable<ViewPages>,
): Promise<void> {
  const pages = [...views].filter((v) => !v.maintenance).flatMap((v) => v.pages());
  const seen = new Set<number>();
  for (const page of pages) {
    const targetId = host.dispatcher.targetIdOf(page);
    if (targetId === undefined) continue;
    const windowId = await host.targets.windowOf(targetId);
    if (windowId === null || seen.has(windowId)) continue;
    seen.add(windowId);
    await host.targets.minimize(targetId);
  }
}

/**
 * Windows that show pages of more than one session (spec 13 §3.4: placement is not attribution; the
 * template page lists them as "shared by several sessions").
 */
export async function sharedWindows(
  host: HostOpsTarget,
  views: Iterable<ViewPages>,
): Promise<readonly SharedWindowInfo[]> {
  const sessionsByWindow = new Map<number, Set<string>>();
  for (const view of views) {
    for (const windowId of await windowsOf(host, view.pages())) {
      const sessions = sessionsByWindow.get(windowId) ?? new Set<string>();
      sessions.add(view.sessionId);
      sessionsByWindow.set(windowId, sessions);
    }
  }
  return [...sessionsByWindow]
    .filter(([, sessions]) => sessions.size > 1)
    .map(([windowId, sessions]) => ({ windowId, sessionIds: [...sessions].sort() }));
}

/** How long a download in the template's downloads directory waits for a session to save it (§5.5). */
export const UNCLAIMED_DOWNLOAD_MS = 60_000;

/**
 * Deletes every download of `page` from the template's own downloads directory after
 * {@link UNCLAIMED_DOWNLOAD_MS} (spec 13 §5.5): a session saves its download into its own
 * directory before then (`saveAs` copies), so what is left is a download no session claimed.
 */
export function deleteUnclaimedDownloads(page: Page): void {
  const emitter: { on?: unknown } = page;
  if (typeof emitter.on !== 'function') return;
  page.on('download', (download) => {
    const timer = setTimeout(() => {
      void download.delete().catch(() => undefined);
    }, UNCLAIMED_DOWNLOAD_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });
}

/** Origins remembered per host at most (newest kept). */
const MAX_COMMITTED_ORIGINS = 10_000;

/**
 * Records the `http(s)` origin of every frame `page` commits into `origins` (a sign-in removal
 * clears every origin under the domain, also those without a cookie of their own).
 */
export function watchOrigins(page: Page, origins: Set<string>): void {
  const emitter: { on?: unknown } = page;
  if (typeof emitter.on !== 'function') return;
  const add = (url: string): void => {
    if (!/^https?:/i.test(url)) return;
    try {
      origins.add(new URL(url).origin);
    } catch {
      return;
    }
    if (origins.size > MAX_COMMITTED_ORIGINS) {
      const oldest = origins.values().next();
      if (oldest.done !== true) origins.delete(oldest.value);
    }
  };
  page.on('framenavigated', (frame) => add(frame.url()));
}

/**
 * A page an agent's site opened while a sign-in window is open (spec 13 §3.3, review M-1): when it
 * landed in the sign-in window (placement is not attribution) it is closed; otherwise its window is
 * minimized. Then the sign-in window is shown again, so the operator's typing goes back to it.
 */
export async function stepAside(
  host: HostOpsTarget,
  page: Page,
  recording: { readonly windows: ReadonlySet<number>; readonly front: Page | null },
): Promise<'closed' | 'minimized' | 'none'> {
  const targetId = host.dispatcher.targetIdOf(page);
  if (targetId === undefined || page.isClosed()) return 'none';
  const windowId = await host.targets.windowOf(targetId);
  let outcome: 'closed' | 'minimized';
  if (windowId !== null && recording.windows.has(windowId)) {
    await page.close({ runBeforeUnload: false }).catch(() => undefined);
    outcome = 'closed';
  } else {
    await host.targets.minimize(targetId);
    outcome = 'minimized';
  }
  await recording.front?.bringToFront().catch(() => undefined);
  return outcome;
}

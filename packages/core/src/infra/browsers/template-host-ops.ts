/** @module infra/browsers/template-host-ops — operator operations on a running template host (spec 13 §2.3, §3.3, §3.4): removing a domain's sign-in, minimizing agent windows while a recording is open, and the windows several sessions share. */

import type { BrowserContext, Page } from 'playwright';
import { registrableDomain } from '../../kernel/url.ts';
import type { SharedWindowInfo } from '../../ports/template-host.ts';
import type { HostPageDispatcher } from './page-dispatcher.ts';
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

/**
 * Removes the sign-in of `domain` (a registrable domain) from the host (spec 13 §2.3 **Remove
 * sign-in**): every cookie on it or a subdomain, and the site data of the origins those cookies and
 * the domain name. Returns the number of cookies removed.
 */
export async function clearSignIn(host: HostOpsTarget, domain: string): Promise<number> {
  const cookies = await host.context.cookies();
  const matching = cookies.filter((c) => registrableDomain(cookieHost(c.domain)) === domain);
  await host.context.clearCookies({ domain: new RegExp(`(^|\\.)${escapeRegExp(domain)}$`) });
  const hosts = new Set([domain, `www.${domain}`, ...matching.map((c) => cookieHost(c.domain))]);
  const origins = [...hosts].flatMap((h) => [`https://${h}`, `http://${h}`]);
  await host.targets.clearOriginData(origins);
  return matching.length;
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

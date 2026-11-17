/** @module infra/browsers/page-sites — the registrable domains a template browser's windows opened as pages (spec 13 §2.3, review #85 H1, M3, M4): every top-level document request of the context, redirect hops and popups' first pages included (embedded frames and subresources never count), kept per template in `<data-dir>/templates/<id>/page-sites.json` (registrable domains only, the newest {@link MAX_PAGE_SITES}) so an unlisted sign-in to a domain without a pack survives a restart. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BrowserContext } from 'patchright';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import { registrableDomain } from '../../kernel/url.ts';
import type { Logger } from '../../ports/logger.ts';

/** Registrable domains kept per template at most (the oldest go first; like D27's origin cap). */
export const MAX_PAGE_SITES = 10_000;

/** The file next to a template's profile (`<data-dir>/templates/<id>/page-sites.json`). */
export function pageSitesFileOf(userDataDir: string): string {
  return join(dirname(userDataDir), 'page-sites.json');
}

/** The registrable domain of an `http(s)` URL, or `''`. */
export function siteOfUrl(url: string): string {
  if (!/^https?:/i.test(url)) return '';
  try {
    return registrableDomain(new URL(url).hostname);
  } catch {
    return '';
  }
}

/** What {@link isTopLevelNavigation} reads of a request (Patchright's `Request` fits). */
export interface NavRequest {
  isNavigationRequest(): boolean;
  frame(): { parentFrame(): unknown };
}

/** What {@link hopsOf} reads of a request. */
export interface HopRequest {
  url(): string;
  redirectedFrom(): HopRequest | null;
}

/**
 * True for a top-level document request: a navigation of a page's main frame (a popup's first
 * page included). An embedded frame's navigation, a subresource or a worker's request is not one.
 */
export function isTopLevelNavigation(request: NavRequest): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame().parentFrame() === null;
  } catch {
    // A service worker's request has no frame.
    return false;
  }
}

/** The URLs of a top-level request and every redirect hop that led to it. */
export function hopsOf(request: HopRequest): string[] {
  const urls: string[] = [];
  let current: HopRequest | null = request;
  for (let i = 0; current !== null && i < 32; i += 1) {
    urls.push(current.url());
    current = current.redirectedFrom();
  }
  return urls;
}

/** Adds `site` as the newest entry of `sites` (oldest evicted past the cap); `true` when new. */
export function addPageSite(sites: Set<string>, site: string): boolean {
  if (site === '') return false;
  const known = sites.has(site);
  if (known) sites.delete(site);
  sites.add(site);
  if (sites.size > MAX_PAGE_SITES) {
    const oldest = sites.values().next();
    if (oldest.done !== true) sites.delete(oldest.value);
  }
  return !known;
}

/** Reads a template's page sites; `[]` when the file is missing or unreadable. */
export async function readPageSites(file: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed)
      ? parsed
          .filter((s): s is string => typeof s === 'string' && s.length <= 253)
          .slice(-MAX_PAGE_SITES)
      : [];
  } catch {
    return [];
  }
}

/** Writes a template's page sites (atomically: a temporary file, then a rename). */
export async function writePageSites(file: string, sites: Iterable<string>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify([...sites]), 'utf8');
  await rename(temp, file);
}

/**
 * Records into `sites` the registrable domain of every top-level document request of `context`
 * (each redirect hop and every popup's pages included) and persists the set to `file` (when given)
 * a moment after it grows. Loads the file first. Returns `record` (a page the host adopted: its
 * URL, for a popup whose first request went by before the context was watched) and `flush` (writes
 * now, on close).
 */
export function watchPageSites(
  context: BrowserContext,
  sites: Set<string>,
  file: string | null,
  log: Logger,
): { readonly record: (url: string) => void; readonly flush: () => Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  const flush = async (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (file === null || !dirty) return;
    dirty = false;
    try {
      await writePageSites(file, sites);
    } catch (err) {
      log.warn('page sites not saved', { err: serializeError(err) });
    }
  };
  const grew = (): void => {
    dirty = true;
    if (file === null || timer !== null) return;
    timer = setTimeout(() => void flush(), 1_000);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  };
  const record = (url: string): void => {
    if (addPageSite(sites, siteOfUrl(url))) grew();
  };
  if (file !== null) {
    void readPageSites(file).then((stored) => {
      // Stored domains are older than anything recorded since the browser started.
      const fresh = [...sites];
      sites.clear();
      for (const site of [...stored, ...fresh]) addPageSite(sites, site);
    });
  }
  const emitter: { on?: unknown } = context;
  if (typeof emitter.on === 'function') {
    context.on('request', (request) => {
      if (!isTopLevelNavigation(request)) return;
      for (const url of hopsOf(request)) record(url);
    });
  }
  return { record, flush };
}

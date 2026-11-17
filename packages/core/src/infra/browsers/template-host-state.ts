/** @module infra/browsers/template-host-state — a template host's state and memory operations (spec 13 §3.2, §3.9, §3.12, §7.4): the storage state read into memory with IndexedDB, applied with `setStorageState`, the JavaScript heap of each session's pages for the memory trim, and closing one page by target id. */

import type { BrowserContext, Page } from 'patchright';
import { readBounded } from '../../kernel/bounded.ts';
import { withDeadline } from '../../kernel/deadline.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ActivePageOf, PageHeap } from '../../ports/template-host.ts';
import type { TemplateState } from '../../ports/template-state.ts';
import type { HostPageDispatcher } from './page-dispatcher.ts';
import type { ViewPages } from './template-host-ops.ts';

/** How long one page's heap read may take before it is skipped. */
const HEAP_READ_MS = 2_000;

/** Heap reads in flight at once (spec 13 §3.2 memory; review #79 L-7). */
export const HEAP_READ_CONCURRENCY = 8;

/** Overall limit of one host's heap reads: pages not read by then are skipped (count 0). */
export const HEAP_READS_DEADLINE_MS = 10_000;

/** Limits of {@link pageHeaps} (tests shorten them). */
export interface HeapReadLimits {
  readonly concurrency: number;
  readonly deadlineMs: number;
}

/** Options of {@link pageHeaps}. */
export interface HeapReadOptions extends Partial<HeapReadLimits> {
  /** Each session's active tab: marked `active` so the memory trim never closes it. */
  readonly activeOf?: ActivePageOf | undefined;
}

/**
 * The template's storage state in memory (`storageState({indexedDB: true})`, spec 13 §3.9). Never
 * given a `path`: the plaintext is never written to disk (spec 13 §2.4).
 */
export async function readStorageState(context: BrowserContext): Promise<TemplateState> {
  const state = await context.storageState({ indexedDB: true });
  return state as unknown as TemplateState;
}

/**
 * Applies a state (spec 13 §3.12, §7.4): Playwright clears the cookies and the storage of the
 * origins it knows and sets the state's; origins outside both keep their data.
 */
export async function applyStorageState(
  context: BrowserContext,
  state: TemplateState,
): Promise<void> {
  // Only cookies and origins: a `credentials` key would install a virtual authenticator.
  await context.setStorageState({
    cookies: state.cookies.map((c) => ({ ...c })),
    origins: state.origins.map((o) => ({ ...o, localStorage: [...o.localStorage] })),
  } as Parameters<BrowserContext['setStorageState']>[0]);
}

async function heapOf(context: BrowserContext, page: Page): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), HEAP_READ_MS);
  });
  const read = (async () => {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Performance.enable');
      const { metrics } = await cdp.send('Performance.getMetrics');
      return metrics.find((m) => m.name === 'JSHeapTotalSize')?.value ?? null;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  })().catch(() => null);
  try {
    return await Promise.race([read, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `JSHeapTotalSize` of every agent page (spec 13 §3.2 memory), by session, read
 * {@link HEAP_READ_CONCURRENCY} at a time within {@link HEAP_READS_DEADLINE_MS} so a host with
 * many pages never holds the supervisor's tick. Maintenance pages are not trimmed. Pages that are
 * unreadable, or not read before the deadline, are skipped (they count 0).
 */
export async function pageHeaps(
  context: BrowserContext,
  dispatcher: HostPageDispatcher,
  views: Iterable<ViewPages>,
  log: Logger,
  options: HeapReadOptions = {},
): Promise<readonly PageHeap[]> {
  const limits: HeapReadLimits = {
    concurrency: options.concurrency ?? HEAP_READ_CONCURRENCY,
    deadlineMs: options.deadlineMs ?? HEAP_READS_DEADLINE_MS,
  };
  const targets: {
    readonly sessionId: string;
    readonly targetId: string;
    readonly page: Page;
    readonly active: boolean;
  }[] = [];
  for (const view of views) {
    if (view.maintenance) continue;
    const active = options.activeOf?.(view.sessionId);
    for (const page of view.pages()) {
      const targetId = dispatcher.targetIdOf(page);
      if (targetId !== undefined) {
        targets.push({ sessionId: view.sessionId, targetId, page, active: page === active });
      }
    }
  }
  const deadline = withDeadline(undefined, limits.deadlineMs);
  let bytes: (number | null)[];
  try {
    bytes = await readBounded(targets, (target) => heapOf(context, target.page), {
      concurrency: limits.concurrency,
      signal: deadline.signal,
    });
  } finally {
    deadline.clear();
  }
  const out: PageHeap[] = [];
  let unread = 0;
  targets.forEach((target, index) => {
    const value = bytes[index];
    if (value === null || value === undefined) {
      unread += 1;
      return;
    }
    out.push({
      sessionId: target.sessionId,
      targetId: target.targetId,
      jsHeapTotalBytes: Math.round(value),
      ...(target.active && { active: true }),
    });
  });
  if (unread > 0) log.debug('page heaps unread', { unread, pages: targets.length });
  return out;
}

/** Closes the page with `targetId` among `pages`; false when none matches. */
export async function closePageByTarget(
  dispatcher: HostPageDispatcher,
  pages: readonly Page[],
  targetId: string,
  log: Logger,
): Promise<boolean> {
  const page = pages.find((p) => dispatcher.targetIdOf(p) === targetId);
  if (page === undefined) return false;
  await page.close({ runBeforeUnload: false }).catch((err: unknown) => {
    log.debug('page close failed', { err: serializeError(err) });
  });
  return true;
}

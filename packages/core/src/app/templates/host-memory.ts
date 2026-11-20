/** @module app/templates/host-memory — the memory limit of template hosts (spec 13 §3.2): above `templateRecycleRss` the heaviest session (by JavaScript heap) loses its largest background tab, or is only warned when it holds just its active tab (workload test B2; never another session's tab, review #88 M1); a minute later, still above, every tab of the heaviest session is closed (the backstop, M2); five minutes after the first trim the host is drained with a one-minute drain timeout. Each step gives the session a `SESSION_RESOURCE_LIMIT` warning. */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { ActivePageOf, PageHeap, TemplateHost } from '../../ports/template-host.ts';
import type { SessionService } from '../sessions/session-service.ts';

/** How long a trimmed host may stay above the limit before it is drained (spec 13 §3.2). */
export const MEMORY_DRAIN_AFTER_MS = 5 * 60_000;

/**
 * How long after the first trim a host still above the limit waits before the backstop closes every
 * tab of the heaviest session, its active tab included (review #88 M2).
 */
export const MEMORY_BACKSTOP_AFTER_MS = 60_000;

/** The drain timeout of a host drained for memory: sessions get this long, not `templateDrainTimeout`. */
export const MEMORY_DRAIN_TIMEOUT_MS = 60_000;

/** The warning text: what happened and what the session can do (spec 13 §5 wording). */
export const RESOURCE_LIMIT_MESSAGE =
  "Memory is running low, so this session's largest background tab was closed. Close tabs you no longer need.";

/** The warning when the heaviest session holds only its active tab: nothing was closed yet. */
export const RESOURCE_LIMIT_KEPT_MESSAGE =
  "Memory is running low and this session's tab uses the most. Close tabs you no longer need or open lighter pages; if memory stays high for a minute, this session's tabs are closed.";

/** The warning when the backstop closed every tab of the session. */
export const RESOURCE_LIMIT_CLOSED_ALL_MESSAGE =
  "Memory stayed too high, so this session's tabs were closed, the active one included.";

/** The warning after a site-opened page over the session's cap was closed (spec 13 §6.3). */
export const PAGE_LIMIT_MESSAGE =
  'This session has reached its tab limit; a page a site opened was closed. Close a tab you no longer need.';

/** What the trim did to the session it warns. */
export type TrimAction = 'background' | 'none' | 'all';

/** What one memory check decided. */
export type MemoryVerdict = 'ok' | 'trimmed' | 'waiting' | 'drain';

/** Collaborators of {@link HostMemoryGuard}. */
export interface HostMemoryDeps {
  /** `templateRecycleRss` in bytes; `0` disables the guard. */
  readonly limitBytes: number;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Gives a session the `SESSION_RESOURCE_LIMIT` warning for what was done to it. */
  readonly warn: (
    sessionId: string,
    details: Readonly<Record<string, unknown>>,
    action: TrimAction,
  ) => void;
  /** Each session's active tab, which the first trim never closes (workload test B2). */
  readonly activeOf?: ActivePageOf;
  /**
   * Closes every tab of a session (the backstop); absent → the pages the heap read found are
   * closed one by one.
   */
  readonly closeAll?: (sessionId: string) => Promise<void>;
}

/** The heaviest session: its summed heap and its largest page that is not its active tab (`null`: none). */
export interface TrimPick {
  readonly sessionId: string;
  readonly page: PageHeap | null;
  readonly total: number;
}

/**
 * The session holding the most heap, and its largest page that is not its active tab (`page:
 * null` when it holds only its active tab). Only the heaviest session is considered: a lighter
 * session's tab is never closed to make up for it (review #88 M1). `null` without heaps.
 */
export function largestConsumer(heaps: readonly PageHeap[]): TrimPick | null {
  const totals = new Map<string, { total: number; page: PageHeap | null }>();
  for (const heap of heaps) {
    const entry = totals.get(heap.sessionId) ?? { total: 0, page: null };
    totals.set(heap.sessionId, entry);
    entry.total += heap.jsHeapTotalBytes;
    if (heap.active === true) continue;
    if (entry.page === null || heap.jsHeapTotalBytes > entry.page.jsHeapTotalBytes) {
      entry.page = heap;
    }
  }
  let best: TrimPick | null = null;
  for (const [sessionId, { total, page }] of totals) {
    if (best === null || total > best.total) best = { sessionId, page, total };
  }
  return best;
}

/** Where a host over the limit stands. */
interface OverLimit {
  /** When it was first trimmed. */
  readonly since: number;
  /** Whether the backstop already closed the heaviest session's tabs. */
  backstopped: boolean;
}

/**
 * Tracks each host against the limit across ticks: the first tick over the limit trims the heaviest
 * session (its largest background tab, or only a warning); a minute later, still over, the backstop
 * closes every tab of the then heaviest session; five minutes after the first trim the host drains.
 */
export class HostMemoryGuard {
  readonly #deps: HostMemoryDeps;
  readonly #log: Logger;
  readonly #over = new Map<string, OverLimit>();

  constructor(deps: HostMemoryDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.memory' });
  }

  /**
   * One check of a running host with memory `rssBytes`: below the limit → `ok` (and the host's
   * state is forgotten); first time above → the heaviest session is trimmed (`trimmed`); still above
   * after {@link MEMORY_BACKSTOP_AFTER_MS} → the backstop (`trimmed`); otherwise `waiting`, and
   * still above after {@link MEMORY_DRAIN_AFTER_MS} → `drain`.
   */
  async check(templateId: string, rssBytes: number, host: TemplateHost): Promise<MemoryVerdict> {
    const limit = this.#deps.limitBytes;
    if (limit <= 0 || rssBytes <= limit) {
      this.#over.delete(templateId);
      return 'ok';
    }
    const now = this.#deps.clock.now();
    const over = this.#over.get(templateId);
    if (over === undefined) {
      this.#over.set(templateId, { since: now, backstopped: false });
      await this.#trim(templateId, rssBytes, host, false);
      return 'trimmed';
    }
    if (now - over.since >= MEMORY_DRAIN_AFTER_MS) {
      this.#over.delete(templateId);
      this.#log.warn('host over memory, drain', { templateId, rssBytes, limitBytes: limit });
      return 'drain';
    }
    if (!over.backstopped && now - over.since >= MEMORY_BACKSTOP_AFTER_MS) {
      over.backstopped = true;
      await this.#trim(templateId, rssBytes, host, true);
      return 'trimmed';
    }
    return 'waiting';
  }

  async #trim(templateId: string, rssBytes: number, host: TemplateHost, all: boolean) {
    try {
      const heaps = await host.pageHeaps(this.#deps.activeOf);
      const top = largestConsumer(heaps);
      if (top === null) return;
      let action: TrimAction = 'none';
      if (all) {
        if (this.#deps.closeAll !== undefined) await this.#deps.closeAll(top.sessionId);
        else {
          for (const heap of heaps.filter((h) => h.sessionId === top.sessionId)) {
            await host.closePage(heap.targetId, 'session');
          }
        }
        action = 'all';
      } else if (top.page !== null && (await host.closePage(top.page.targetId, 'session'))) {
        action = 'background';
      }
      const limitBytes = this.#deps.limitBytes;
      this.#log.warn('host over memory, trimmed', {
        templateId,
        sessionId: top.sessionId,
        rssBytes,
        limitBytes,
        action,
      });
      this.#deps.warn(
        top.sessionId,
        { rss_bytes: rssBytes, limit_bytes: limitBytes, js_heap_bytes: top.total },
        action,
      );
    } catch (err) {
      this.#log.warn('memory trim failed', { templateId, err: serializeError(err) });
    }
  }

  /** Forgets a host (stopped, deleted). */
  forget(templateId: string): void {
    this.#over.delete(templateId);
  }
}

/** The warning text for what the trim did to a session. */
export function resourceLimitMessage(action: TrimAction): string {
  return action === 'background'
    ? RESOURCE_LIMIT_MESSAGE
    : action === 'all'
      ? RESOURCE_LIMIT_CLOSED_ALL_MESSAGE
      : RESOURCE_LIMIT_KEPT_MESSAGE;
}

/**
 * Closes every tab of a session (the memory backstop) and notes why on its tab registry, so the
 * agent's next page tool says what happened (`TAB_NOT_FOUND` with the reason and `new_tab`).
 */
export async function closeSessionTabs(
  sessions: Pick<SessionService, 'peek'>,
  sessionId: string,
): Promise<void> {
  const session = sessions.peek(sessionId);
  if (session === undefined) return;
  session.tabs.noteAllClosed(RESOURCE_LIMIT_CLOSED_ALL_MESSAGE);
  const pages = session.view?.pages() ?? [];
  await Promise.all(
    pages.map((page) => page.close({ runBeforeUnload: false }).catch(() => undefined)),
  );
}

/** Gives a session a warning (page cap, memory limit), if it still exists. */
export function warnSession(
  sessions: Pick<SessionService, 'peek' | 'warn'>,
  sessionId: string,
  code: 'SESSION_PAGE_LIMIT' | 'SESSION_RESOURCE_LIMIT',
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): void {
  const session = sessions.peek(sessionId);
  if (session === undefined) return;
  sessions.warn(session, {
    code,
    sessionId,
    message,
    ...(Object.keys(details).length > 0 && { details: { ...details } }),
  });
}

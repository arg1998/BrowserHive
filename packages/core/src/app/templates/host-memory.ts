/** @module app/templates/host-memory — the memory limit of template hosts (spec 13 §3.2): above `templateRecycleRss` the session whose pages hold the most JavaScript heap loses its largest page and gets the `SESSION_RESOURCE_LIMIT` warning; a host still above the limit five minutes later is drained and restarted. */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { PageHeap, TemplateHost } from '../../ports/template-host.ts';
import type { SessionService } from '../sessions/session-service.ts';

/** How long a trimmed host may stay above the limit before it is drained (spec 13 §3.2). */
export const MEMORY_DRAIN_AFTER_MS = 5 * 60_000;

/** The warning text: what happened and what the session can do (spec 13 §5 wording). */
export const RESOURCE_LIMIT_MESSAGE =
  "Memory is running low, so this session's largest page was closed. Close pages you no longer need.";

/** The warning after a site-opened page over the session's cap was closed (spec 13 §6.3). */
export const PAGE_LIMIT_MESSAGE =
  'This session has reached its tab limit; a page a site opened was closed. Close a tab you no longer need.';

/** What one memory check decided. */
export type MemoryVerdict = 'ok' | 'trimmed' | 'waiting' | 'drain';

/** Collaborators of {@link HostMemoryGuard}. */
export interface HostMemoryDeps {
  /** `templateRecycleRss` in bytes; `0` disables the guard. */
  readonly limitBytes: number;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Gives a session the `SESSION_RESOURCE_LIMIT` warning. */
  readonly warn: (sessionId: string, details: Readonly<Record<string, unknown>>) => void;
}

/** The session holding the most heap and its largest page. */
export function largestConsumer(
  heaps: readonly PageHeap[],
): { readonly sessionId: string; readonly page: PageHeap; readonly total: number } | null {
  const totals = new Map<string, { total: number; page: PageHeap }>();
  for (const heap of heaps) {
    const entry = totals.get(heap.sessionId);
    if (entry === undefined) {
      totals.set(heap.sessionId, { total: heap.jsHeapTotalBytes, page: heap });
      continue;
    }
    entry.total += heap.jsHeapTotalBytes;
    if (heap.jsHeapTotalBytes > entry.page.jsHeapTotalBytes) entry.page = heap;
  }
  let best: { sessionId: string; page: PageHeap; total: number } | null = null;
  for (const [sessionId, { total, page }] of totals) {
    if (best === null || total > best.total) best = { sessionId, page, total };
  }
  return best;
}

/** Tracks each host against the limit across ticks. */
export class HostMemoryGuard {
  readonly #deps: HostMemoryDeps;
  readonly #log: Logger;
  /** When each host over the limit was trimmed. */
  readonly #trimmedAt = new Map<string, number>();

  constructor(deps: HostMemoryDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ module: 'templates.memory' });
  }

  /**
   * One check of a running host with resident memory `rssBytes`: below the limit → `ok` (and the
   * host's trim is forgotten); first time above → the largest consumer is trimmed (`trimmed`);
   * still above within five minutes → `waiting`; still above after them → `drain`.
   */
  async check(templateId: string, rssBytes: number, host: TemplateHost): Promise<MemoryVerdict> {
    const limit = this.#deps.limitBytes;
    if (limit <= 0 || rssBytes <= limit) {
      this.#trimmedAt.delete(templateId);
      return 'ok';
    }
    const now = this.#deps.clock.now();
    const trimmedAt = this.#trimmedAt.get(templateId);
    if (trimmedAt !== undefined) {
      if (now - trimmedAt < MEMORY_DRAIN_AFTER_MS) return 'waiting';
      this.#trimmedAt.delete(templateId);
      this.#log.warn('host over memory, drain', {
        templateId,
        rssBytes,
        limitBytes: limit,
      });
      return 'drain';
    }
    this.#trimmedAt.set(templateId, now);
    try {
      const top = largestConsumer(await host.pageHeaps());
      if (top === null) return 'trimmed';
      const closed = await host.closePage(top.page.targetId, 'session');
      this.#log.warn('host over memory, trimmed', {
        templateId,
        sessionId: top.sessionId,
        rssBytes,
        limitBytes: limit,
        closed,
      });
      this.#deps.warn(top.sessionId, {
        rss_bytes: rssBytes,
        limit_bytes: limit,
        js_heap_bytes: top.total,
      });
    } catch (err) {
      this.#log.warn('memory trim failed', { templateId, err: serializeError(err) });
    }
    return 'trimmed';
  }

  /** Forgets a host (stopped, deleted). */
  forget(templateId: string): void {
    this.#trimmedAt.delete(templateId);
  }
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

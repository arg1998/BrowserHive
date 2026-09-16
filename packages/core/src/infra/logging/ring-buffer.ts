/** @module infra/logging/ring-buffer — bounded in-process record store behind `/api/v1/logs` and the `logs` WS topic (spec 10 §4.3, §10). */

import type { LogLevel } from '../../ports/logger.ts';
import { LEVEL_ORDER } from './level-spec.ts';
import type { LogRecord } from './record.ts';

/** Default capacity (`--logRingSize`). Oldest records are dropped first. */
export const DEFAULT_RING_SIZE = 5_000;

/** Upper bound on one query page. */
export const MAX_QUERY_LIMIT = 1_000;

/** A stored record with its monotonically increasing sequence number (the keyset cursor). */
export interface RingEntry {
  readonly seq: number;
  readonly record: LogRecord;
}

/** Scan direction of {@link LogRingBuffer.query}. */
export type LogOrder = 'asc' | 'desc';

/** Filters for {@link LogRingBuffer.query}; all optional, all AND-ed. */
export interface LogQuery {
  /**
   * Keyset cursor (a `seq` from a previous page's `nextCursor`): `asc` returns entries with `seq`
   * strictly greater, `desc` entries with `seq` strictly smaller.
   */
  readonly cursor?: number;
  /** `asc` (default): oldest first. `desc`: newest first, the cursor pages to older entries. */
  readonly order?: LogOrder;
  /** Only entries with `seq` strictly greater than this (gap fill after a reconnect). */
  readonly afterSeq?: number;
  /** Exact levels to include (`level[]`). */
  readonly level?: readonly LogLevel[];
  /** Records at this level or more severe (`min_level`). */
  readonly minLevel?: LogLevel;
  /** Module roots or full module names (`module[]`); `sessions` matches `sessions.lifecycle`. */
  readonly module?: readonly string[];
  readonly sessionId?: string;
  readonly traceId?: string;
  readonly requestId?: string;
  /** Case-insensitive substring over `msg` and the JSON of the fields. */
  readonly q?: string;
  /** Inclusive epoch-ms bounds on `ts`. */
  readonly since?: number;
  readonly until?: number;
  /** Page size, clamped to {@link MAX_QUERY_LIMIT}. Default 100. */
  readonly limit?: number;
}

/** One page of entries in the query's `order`. */
export interface LogPage {
  readonly items: readonly RingEntry[];
  /**
   * Cursor for the next page in the same order (newer for `asc`, older for `desc`), or `null`
   * when no further matching entry is held.
   */
  readonly nextCursor: number | null;
}

/** Listener invoked synchronously for every pushed entry (the WS `logs` topic). */
export type RingListener = (entry: RingEntry) => void;

/** Bounded, append-only record store with keyset queries and subscriptions. */
export interface LogRingBuffer {
  readonly capacity: number;
  /** Number of entries currently held. */
  readonly size: number;
  /** Sequence of the newest entry, or `0` when empty. */
  readonly latestSeq: number;
  /** Stores `record`, evicting the oldest when full. Returns the assigned `seq`. */
  push(record: LogRecord): number;
  /** Filters held entries. Never throws. */
  query(query?: LogQuery): LogPage;
  /** All held entries, oldest first (tests, export). */
  toArray(): readonly RingEntry[];
  /** Registers a listener; returns the unsubscribe function. A throwing listener is dropped. */
  subscribe(listener: RingListener): () => void;
  /** Drops every entry (sequence numbers keep increasing). */
  clear(): void;
}

/** Builds a {@link LogRingBuffer} with `capacity` slots (default {@link DEFAULT_RING_SIZE}). */
export function createRingBuffer(capacity = DEFAULT_RING_SIZE): LogRingBuffer {
  const cap = Math.max(1, Math.floor(capacity));
  const slots: (RingEntry | undefined)[] = new Array(cap).fill(undefined);
  let head = 0; // next write position
  let count = 0;
  let seq = 0;
  const listeners = new Set<RingListener>();

  const entries = (): RingEntry[] => {
    const out: RingEntry[] = [];
    const start = (head - count + cap) % cap;
    for (let i = 0; i < count; i += 1) {
      const entry = slots[(start + i) % cap];
      if (entry !== undefined) out.push(entry);
    }
    return out;
  };

  return {
    capacity: cap,
    get size() {
      return count;
    },
    get latestSeq() {
      return seq;
    },
    push(record) {
      seq += 1;
      const entry: RingEntry = { seq, record };
      slots[head] = entry;
      head = (head + 1) % cap;
      if (count < cap) count += 1;
      for (const listener of [...listeners]) {
        try {
          listener(entry);
        } catch {
          // A misbehaving subscriber must never take the logger down; drop it.
          listeners.delete(listener);
        }
      }
      return seq;
    },
    query(query = {}) {
      const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(query.limit ?? 100)));
      const predicate = buildPredicate(query);
      const items: RingEntry[] = [];
      let reachedEnd = true;
      const desc = query.order === 'desc';
      const held = entries();
      if (desc) held.reverse();
      for (const entry of held) {
        if (query.cursor !== undefined) {
          if (desc ? entry.seq >= query.cursor : entry.seq <= query.cursor) continue;
        }
        if (query.afterSeq !== undefined && entry.seq <= query.afterSeq) {
          if (desc) break;
          continue;
        }
        if (!predicate(entry.record)) continue;
        if (items.length === limit) {
          reachedEnd = false;
          break;
        }
        items.push(entry);
      }
      const last = items[items.length - 1];
      return { items, nextCursor: reachedEnd || last === undefined ? null : last.seq };
    },
    toArray() {
      return entries();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      slots.fill(undefined);
      head = 0;
      count = 0;
    },
  };
}

function buildPredicate(query: LogQuery): (record: LogRecord) => boolean {
  const levels =
    query.level !== undefined && query.level.length > 0 ? new Set(query.level) : undefined;
  const minRank = query.minLevel !== undefined ? LEVEL_ORDER[query.minLevel] : undefined;
  const modules = query.module !== undefined && query.module.length > 0 ? query.module : undefined;
  const needle = query.q !== undefined && query.q.length > 0 ? query.q.toLowerCase() : undefined;
  return (record) => {
    if (levels !== undefined && !levels.has(record.level)) return false;
    if (minRank !== undefined && LEVEL_ORDER[record.level] > minRank) return false;
    if (
      modules !== undefined &&
      !modules.some((m) => record.module === m || record.module.startsWith(`${m}.`))
    ) {
      return false;
    }
    if (query.sessionId !== undefined && record.session_id !== query.sessionId) return false;
    if (query.traceId !== undefined && record.trace_id !== query.traceId) return false;
    if (query.requestId !== undefined && record.request_id !== query.requestId) return false;
    if (query.since !== undefined && record.ts < query.since) return false;
    if (query.until !== undefined && record.ts > query.until) return false;
    if (needle !== undefined) {
      const haystack = `${record.msg} ${safeJson(record)}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

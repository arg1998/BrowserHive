/** @module features/logs/log-buffer — the live log buffer as a pure reducer: newest-first records, older pages appended by cursor, live/gap-fill records merged by `seq` (never wiping), pause holding new records aside */
import type { LogRecord } from '@browserhive/contracts/http';

/** Client buffer cap (mirrors the server ring default). */
export const LOG_BUFFER_MAX = 5000;

/** Why the tail is paused: the operator pressed Pause, or scrolled away from the newest record. */
export type PauseReason = 'manual' | 'scroll';

/** Buffer state. `records` and `held` are newest first (descending `seq`). */
export interface LogBufferState {
  /** Filter key (+ daemon epoch) the records belong to; a different key starts a new buffer. */
  readonly key: string;
  readonly records: readonly LogRecord[];
  /** Records received while paused, shown by "N new" and merged on resume. */
  readonly held: readonly LogRecord[];
  /** Cursor for the next older page; `null` once the start of the ring was reached. */
  readonly olderCursor: string | null;
  /** The first REST page for this key has been merged. */
  readonly seeded: boolean;
  /** Highest `seq` seen for this key (the `after_seq` of a reconnect gap fill). */
  readonly maxSeq: number;
  /** Records received live (WS or gap fill) since the buffer started. */
  readonly received: number;
  readonly paused: PauseReason | null;
  /** The cap dropped the oldest records, so older pages can no longer be walked. */
  readonly truncated: boolean;
}

/** A REST page as the reducer needs it. */
export interface LogPageSlice {
  readonly data: readonly LogRecord[];
  readonly next_cursor: string | null;
}

/** Actions. */
export type LogBufferAction =
  | { readonly type: 'reset'; readonly key: string }
  | { readonly type: 'seed'; readonly key: string; readonly page: LogPageSlice }
  | { readonly type: 'older'; readonly key: string; readonly page: LogPageSlice }
  | { readonly type: 'live'; readonly key: string; readonly records: readonly LogRecord[] }
  | { readonly type: 'pause'; readonly reason: PauseReason }
  | { readonly type: 'resume' };

/** An empty buffer for `key`. */
export function initialLogBuffer(key: string): LogBufferState {
  return {
    key,
    records: [],
    held: [],
    olderCursor: null,
    seeded: false,
    maxSeq: 0,
    received: 0,
    paused: null,
    truncated: false,
  };
}

/**
 * Merge `incoming` into newest-first `current`: dedupe by `seq`, keep descending order, cap at `max`
 * (dropping the oldest). The common live case (every incoming record is newer) avoids a full sort.
 */
export function mergeNewestFirst(
  current: readonly LogRecord[],
  incoming: readonly LogRecord[],
  max = LOG_BUFFER_MAX,
): { readonly records: readonly LogRecord[]; readonly dropped: boolean } {
  if (incoming.length === 0) return { records: current, dropped: false };
  const head = current[0]?.seq ?? -1;
  let merged: LogRecord[];
  if (incoming.every((r) => r.seq > head)) {
    const fresh = new Map<number, LogRecord>();
    for (const r of incoming) fresh.set(r.seq, r);
    merged = [...[...fresh.values()].sort((a, b) => b.seq - a.seq), ...current];
  } else {
    const bySeq = new Map<number, LogRecord>();
    for (const r of current) bySeq.set(r.seq, r);
    for (const r of incoming) bySeq.set(r.seq, r);
    merged = [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  }
  const dropped = merged.length > max;
  return { records: dropped ? merged.slice(0, max) : merged, dropped };
}

function highest(records: readonly LogRecord[], floor: number): number {
  let max = floor;
  for (const r of records) if (r.seq > max) max = r.seq;
  return max;
}

/** Reducer. Every action for another key is ignored, so late responses never mix buffers. */
export function logBufferReducer(state: LogBufferState, action: LogBufferAction): LogBufferState {
  switch (action.type) {
    case 'reset':
      return action.key === state.key ? state : initialLogBuffer(action.key);
    case 'seed': {
      if (action.key !== state.key) return state;
      // A refetch (reconnect, resync) merges into what is already shown; it never wipes the buffer.
      const merged = mergeNewestFirst(state.records, action.page.data);
      return {
        ...state,
        records: merged.records,
        olderCursor: merged.dropped
          ? null
          : state.seeded
            ? state.olderCursor
            : action.page.next_cursor,
        truncated: state.truncated || merged.dropped,
        seeded: true,
        maxSeq: highest(action.page.data, state.maxSeq),
      };
    }
    case 'older': {
      if (action.key !== state.key) return state;
      const merged = mergeNewestFirst(state.records, action.page.data);
      return {
        ...state,
        records: merged.records,
        olderCursor: merged.dropped ? null : action.page.next_cursor,
        truncated: state.truncated || merged.dropped,
        maxSeq: highest(action.page.data, state.maxSeq),
      };
    }
    case 'live': {
      if (action.key !== state.key || action.records.length === 0) return state;
      const maxSeq = highest(action.records, state.maxSeq);
      const received = state.received + action.records.length;
      if (state.paused !== null) {
        const held = mergeNewestFirst(state.held, action.records).records;
        return { ...state, held, maxSeq, received };
      }
      const merged = mergeNewestFirst(state.records, action.records);
      return {
        ...state,
        records: merged.records,
        olderCursor: merged.dropped ? null : state.olderCursor,
        truncated: state.truncated || merged.dropped,
        maxSeq,
        received,
      };
    }
    case 'pause':
      // A manual pause is sticky: scrolling does not downgrade it.
      if (state.paused === 'manual') return state;
      return state.paused === action.reason ? state : { ...state, paused: action.reason };
    case 'resume': {
      if (state.paused === null) return state;
      const merged = mergeNewestFirst(state.records, state.held);
      return {
        ...state,
        records: merged.records,
        held: [],
        paused: null,
        olderCursor: merged.dropped ? null : state.olderCursor,
        truncated: state.truncated || merged.dropped,
      };
    }
  }
}

/** Live records waiting for the next batched flush, tagged with the buffer key they were matched for. */
export interface LiveBatch {
  readonly key: string;
  /** Appended in place while the key matches (a busy tail queues many records per flush). */
  readonly records: LogRecord[];
}

/**
 * Add a live record to the pending batch. A record matched under a different key than the pending
 * batch starts a new batch: what was queued under the previous filters is dropped, never flushed into
 * the new buffer.
 */
export function enqueueLive(batch: LiveBatch, key: string, record: LogRecord): LiveBatch {
  if (batch.key !== key) return { key, records: [record] };
  batch.records.push(record);
  return batch;
}

/** @module features/logs/log-buffer.test — newest-first merge, older-page append, refetch/gap-fill merge without a wipe, pause holding and resume flushing, manual pause stickiness, stale-key actions ignored, cap truncation */

import { describe, expect, it } from 'bun:test';
import { logRecord } from '../../../test/fixtures/ops.ts';
import {
  enqueueLive,
  initialLogBuffer,
  type LogBufferAction,
  type LogBufferState,
  logBufferReducer,
  mergeNewestFirst,
} from './log-buffer.ts';

const seqs = (state: LogBufferState) => state.records.map((r) => r.seq);
const page = (from: number, to: number, next_cursor: string | null = null) => ({
  data: Array.from({ length: from - to + 1 }, (_, i) => logRecord(from - i)),
  next_cursor,
});
const run = (actions: readonly LogBufferAction[], key = 'k') =>
  actions.reduce(logBufferReducer, initialLogBuffer(key));

describe('mergeNewestFirst', () => {
  it('dedupes by seq and keeps descending order for prepends and out-of-order input', () => {
    const current = [logRecord(5), logRecord(4)];
    expect(
      mergeNewestFirst(current, [logRecord(7), logRecord(6)]).records.map((r) => r.seq),
    ).toEqual([7, 6, 5, 4]);
    expect(
      mergeNewestFirst(current, [logRecord(3), logRecord(5), logRecord(8)]).records.map(
        (r) => r.seq,
      ),
    ).toEqual([8, 5, 4, 3]);
  });

  it('caps by dropping the oldest records', () => {
    const merged = mergeNewestFirst([logRecord(2), logRecord(1)], [logRecord(3)], 2);
    expect(merged.records.map((r) => r.seq)).toEqual([3, 2]);
    expect(merged.dropped).toBe(true);
  });
});

describe('logBufferReducer', () => {
  it('seeds newest first and appends older pages by cursor', () => {
    let state = run([{ type: 'seed', key: 'k', page: page(10, 6, 'c1') }]);
    expect(seqs(state)).toEqual([10, 9, 8, 7, 6]);
    expect(state.olderCursor).toBe('c1');
    expect(state.maxSeq).toBe(10);
    state = logBufferReducer(state, { type: 'older', key: 'k', page: page(5, 3, null) });
    expect(seqs(state)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
    expect(state.olderCursor).toBeNull();
  });

  it('puts live records on top and never wipes on a refetch or reconnect gap fill', () => {
    const state = run([
      { type: 'seed', key: 'k', page: page(10, 6, 'c1') },
      { type: 'older', key: 'k', page: page(5, 3, 'c2') },
      { type: 'live', key: 'k', records: [logRecord(11)] },
      // Socket reconnected: refetch of the newest page, then the after_seq gap fill.
      { type: 'seed', key: 'k', page: page(14, 10, 'c-refetch') },
      { type: 'live', key: 'k', records: [logRecord(16), logRecord(15), logRecord(14)] },
    ]);
    expect(seqs(state)).toEqual([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    // The older cursor walked so far survives the refetch.
    expect(state.olderCursor).toBe('c2');
    expect(state.maxSeq).toBe(16);
    expect(state.received).toBe(4);
  });

  it('holds live records while paused and merges them on resume', () => {
    let state = run([
      { type: 'seed', key: 'k', page: page(3, 1) },
      { type: 'pause', reason: 'scroll' },
      { type: 'live', key: 'k', records: [logRecord(4)] },
      { type: 'live', key: 'k', records: [logRecord(5)] },
    ]);
    expect(seqs(state)).toEqual([3, 2, 1]);
    expect(state.held.map((r) => r.seq)).toEqual([5, 4]);
    expect(state.maxSeq).toBe(5);
    state = logBufferReducer(state, { type: 'resume' });
    expect(seqs(state)).toEqual([5, 4, 3, 2, 1]);
    expect(state.held).toEqual([]);
    expect(state.paused).toBeNull();
  });

  it('keeps a manual pause when scrolling would pause again, and stays paused until resumed', () => {
    const state = run([
      { type: 'pause', reason: 'manual' },
      { type: 'pause', reason: 'scroll' },
    ]);
    expect(state.paused).toBe('manual');
    const same = logBufferReducer(state, { type: 'pause', reason: 'manual' });
    expect(same).toBe(state);
  });

  it('starts a fresh buffer for a new key and ignores late actions for the old one', () => {
    let state = run([{ type: 'seed', key: 'k', page: page(3, 1, 'c') }]);
    state = logBufferReducer(state, { type: 'reset', key: 'level=warn' });
    expect(state.records).toEqual([]);
    expect(state.seeded).toBe(false);
    state = logBufferReducer(state, { type: 'seed', key: 'k', page: page(9, 8) });
    state = logBufferReducer(state, { type: 'live', key: 'k', records: [logRecord(10)] });
    expect(state.records).toEqual([]);
    // A reset to the same key is a no-op (never a wipe).
    const seeded = logBufferReducer(state, { type: 'seed', key: 'level=warn', page: page(2, 1) });
    expect(logBufferReducer(seeded, { type: 'reset', key: 'level=warn' })).toBe(seeded);
  });

  it('stops offering older pages once the cap dropped records', () => {
    const big = {
      data: Array.from({ length: 5000 }, (_, i) => logRecord(6000 - i)),
      next_cursor: 'c',
    };
    let state = run([{ type: 'seed', key: 'k', page: big }]);
    expect(state.olderCursor).toBe('c');
    state = logBufferReducer(state, { type: 'live', key: 'k', records: [logRecord(6001)] });
    expect(state.records).toHaveLength(5000);
    expect(state.olderCursor).toBeNull();
    expect(state.truncated).toBe(true);
  });
});

describe('enqueueLive', () => {
  it('batches records per key and drops a batch queued under a previous key', () => {
    let batch = enqueueLive({ key: 'a', records: [] }, 'a', logRecord(1));
    batch = enqueueLive(batch, 'a', logRecord(2));
    expect(batch.records.map((r) => r.seq)).toEqual([1, 2]);
    batch = enqueueLive(batch, 'b', logRecord(3));
    expect(batch).toEqual({ key: 'b', records: [logRecord(3)] });
  });
});

/** @module infra/logging/ring-buffer.test — eviction, keyset paging, filters and subscriptions. */

import { describe, expect, it } from 'bun:test';
import type { LogRecord } from './record.ts';
import { createRingBuffer, DEFAULT_RING_SIZE, MAX_QUERY_LIMIT } from './ring-buffer.ts';

function rec(i: number, extra: Partial<LogRecord> = {}): LogRecord {
  return { ts: i, level: 'info', msg: `m${i}`, module: 'sessions.lifecycle', ...extra };
}

describe('createRingBuffer', () => {
  it('defaults to 5000 slots and evicts the oldest', () => {
    expect(createRingBuffer().capacity).toBe(DEFAULT_RING_SIZE);
    const ring = createRingBuffer(3);
    for (let i = 1; i <= 5; i += 1) ring.push(rec(i));
    expect(ring.size).toBe(3);
    expect(ring.latestSeq).toBe(5);
    expect(ring.toArray().map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('pages with a keyset cursor', () => {
    const ring = createRingBuffer(10);
    for (let i = 1; i <= 7; i += 1) ring.push(rec(i));
    const page1 = ring.query({ limit: 3 });
    expect(page1.items.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page1.nextCursor).toBe(3);
    const page2 = ring.query({ limit: 3, cursor: page1.nextCursor ?? 0 });
    expect(page2.items.map((e) => e.seq)).toEqual([4, 5, 6]);
    const page3 = ring.query({ limit: 3, cursor: page2.nextCursor ?? 0 });
    expect(page3.items.map((e) => e.seq)).toEqual([7]);
    expect(page3.nextCursor).toBeNull();
    expect(ring.query({ limit: 10_000 }).items.length).toBeLessThanOrEqual(MAX_QUERY_LIMIT);
  });

  it('pages newest first with order desc; the cursor walks to older entries', () => {
    const ring = createRingBuffer(10);
    for (let i = 1; i <= 7; i += 1) ring.push(rec(i, { level: i === 4 ? 'error' : 'info' }));
    const page1 = ring.query({ limit: 3, order: 'desc' });
    expect(page1.items.map((e) => e.seq)).toEqual([7, 6, 5]);
    expect(page1.nextCursor).toBe(5);
    const page2 = ring.query({ limit: 3, order: 'desc', cursor: page1.nextCursor ?? 0 });
    expect(page2.items.map((e) => e.seq)).toEqual([4, 3, 2]);
    const page3 = ring.query({ limit: 3, order: 'desc', cursor: page2.nextCursor ?? 0 });
    expect(page3.items.map((e) => e.seq)).toEqual([1]);
    expect(page3.nextCursor).toBeNull();
    // Exactly `limit` matches left → no further page.
    expect(ring.query({ limit: 7, order: 'desc' }).nextCursor).toBeNull();
    // Filters apply before the limit.
    expect(ring.query({ limit: 1, order: 'desc', level: ['info'] }).items[0]?.seq).toBe(7);
    expect(
      ring.query({ order: 'desc', level: ['error'], cursor: 7 }).items.map((e) => e.seq),
    ).toEqual([4]);
  });

  it('afterSeq bounds both orders to entries newer than a known seq (gap fill)', () => {
    const ring = createRingBuffer(10);
    for (let i = 1; i <= 7; i += 1) ring.push(rec(i));
    expect(ring.query({ afterSeq: 5 }).items.map((e) => e.seq)).toEqual([6, 7]);
    const newest = ring.query({ afterSeq: 2, order: 'desc', limit: 3 });
    expect(newest.items.map((e) => e.seq)).toEqual([7, 6, 5]);
    expect(newest.nextCursor).toBe(5);
    const rest = ring.query({ afterSeq: 2, order: 'desc', limit: 3, cursor: 5 });
    expect(rest.items.map((e) => e.seq)).toEqual([4, 3]);
    expect(rest.nextCursor).toBeNull();
  });

  it('filters by level, min level, module root, ids, time and text', () => {
    const ring = createRingBuffer(10);
    ring.push(rec(1, { level: 'error', session_id: 's-1', trace_id: 't-1' }));
    ring.push(rec(2, { level: 'debug', module: 'http.routes', request_id: 'r-2' }));
    ring.push(rec(3, { level: 'warn', module: 'sessions', note: 'needle here' }));
    expect(ring.query({ level: ['error'] }).items.map((e) => e.seq)).toEqual([1]);
    expect(ring.query({ minLevel: 'warn' }).items.map((e) => e.seq)).toEqual([1, 3]);
    expect(ring.query({ module: ['sessions'] }).items.map((e) => e.seq)).toEqual([1, 3]);
    expect(ring.query({ module: ['http.routes'] }).items.map((e) => e.seq)).toEqual([2]);
    expect(ring.query({ sessionId: 's-1' }).items.map((e) => e.seq)).toEqual([1]);
    expect(ring.query({ traceId: 't-1' }).items.map((e) => e.seq)).toEqual([1]);
    expect(ring.query({ requestId: 'r-2' }).items.map((e) => e.seq)).toEqual([2]);
    expect(ring.query({ since: 2, until: 2 }).items.map((e) => e.seq)).toEqual([2]);
    expect(ring.query({ q: 'NEEDLE' }).items.map((e) => e.seq)).toEqual([3]);
    expect(ring.query({ q: 'm2' }).items.map((e) => e.seq)).toEqual([2]);
  });

  it('notifies subscribers and drops a throwing one', () => {
    const ring = createRingBuffer(2);
    const seen: number[] = [];
    const off = ring.subscribe((e) => seen.push(e.seq));
    ring.subscribe(() => {
      throw new Error('bad listener');
    });
    ring.push(rec(1));
    ring.push(rec(2));
    off();
    ring.push(rec(3));
    expect(seen).toEqual([1, 2]);
  });

  it('clear keeps the sequence monotonic', () => {
    const ring = createRingBuffer(2);
    ring.push(rec(1));
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.push(rec(2))).toBe(2);
  });
});

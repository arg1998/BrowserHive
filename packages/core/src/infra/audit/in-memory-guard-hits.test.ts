/** @module infra/audit/in-memory-guard-hits.test — the in-memory hit sink keeps the newest hits within its bound. */

import { describe, expect, it } from 'bun:test';
import type { RequestGuardHit } from '../../ports/request-guard.ts';
import { InMemoryRequestGuardHits, MAX_IN_MEMORY_GUARD_HITS } from './in-memory-guard-hits.ts';

const hit = (ts: number): RequestGuardHit => ({
  sessionId: 'sess-1',
  ruleId: 'r',
  ruleAction: 'block',
  action: 'block',
  outcome: null,
  decidedBy: null,
  requestId: null,
  method: 'POST',
  resourceType: 'fetch',
  url: 'https://a.test/x',
  source: 'request',
  ts,
});

describe('InMemoryRequestGuardHits', () => {
  it('keeps hits in order and drops the oldest past capacity', () => {
    const sink = new InMemoryRequestGuardHits(2);
    for (const ts of [1, 2, 3]) sink.record(hit(ts));
    expect(sink.list().map((h) => h.ts)).toEqual([2, 3]);
    expect(sink.dropped).toBe(1);
  });

  it('defaults to a bounded capacity', () => {
    const sink = new InMemoryRequestGuardHits();
    for (let ts = 0; ts < MAX_IN_MEMORY_GUARD_HITS + 5; ts++) sink.record(hit(ts));
    expect(sink.list()).toHaveLength(MAX_IN_MEMORY_GUARD_HITS);
    expect(sink.list()[0]?.ts).toBe(5);
  });
});

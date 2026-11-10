/** @module domain/policies/request-guard-hits — the in-memory request-guard hit sink, bounded, until the `site_guard_hits` table of PR T3a (spec 13 §9.9). */

import type { RequestGuardHit, RequestGuardHits } from '../../ports/request-guard.ts';

/**
 * Most recent hits kept. A host can send many matching requests (a site retrying a blocked beacon
 * every second); the sink keeps the newest and drops the oldest, so memory stays bounded.
 */
export const MAX_IN_MEMORY_GUARD_HITS = 1_000;

/** Keeps the newest {@link MAX_IN_MEMORY_GUARD_HITS} hits, oldest dropped first. */
export class InMemoryRequestGuardHits implements RequestGuardHits {
  private readonly hits: RequestGuardHit[] = [];
  private readonly capacity: number;
  private droppedCount = 0;

  constructor(capacity: number = MAX_IN_MEMORY_GUARD_HITS) {
    this.capacity = Math.max(1, capacity);
  }

  record(hit: RequestGuardHit): void {
    this.hits.push(hit);
    if (this.hits.length > this.capacity) {
      this.hits.shift();
      this.droppedCount += 1;
    }
  }

  /** The kept hits, oldest first. */
  list(): readonly RequestGuardHit[] {
    return [...this.hits];
  }

  /** How many hits were dropped to stay within capacity. */
  get dropped(): number {
    return this.droppedCount;
  }
}

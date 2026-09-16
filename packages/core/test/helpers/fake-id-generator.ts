/** @module test/helpers/fake-id-generator — sequential, deterministic ids for goldens (spec 09 §4). */

import type { IdGenerator } from '../../src/ports/id-generator.ts';

/** Produces `<prefix>-000001`-style ids so snapshots are stable. */
export class FakeIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();

  private next(kind: string, width: number): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return String(n).padStart(width, '0');
  }

  sessionId(slug: string): string {
    return `${slug}-${this.next('session', 8)}`;
  }

  tabId(): string {
    return `t-${this.next('tab', 6)}`;
  }

  eventId(): string {
    // 26 chars like a ULID, zero-padded so ordering matches insertion order.
    return `e-${this.next('event', 26)}`;
  }

  operatorRequestId(): string {
    return `a-${this.next('request', 12)}`;
  }

  opaque(size: number): string {
    return this.next('opaque', size).slice(-size);
  }

  /** Resets every counter (use between golden cases). */
  reset(): void {
    this.counters = new Map();
  }
}

/** @module ports/persistence/event-log — ordered domain event log (feed replay, audit, export). */

import type { EventRecord, NewEvent } from './records.ts';

/** Repository over `events`; `seq` is monotonic and assigned by the store. */
export interface EventLogRepository {
  /** Appends an event and returns its `seq`. A duplicate `eventId` returns the existing `seq`. */
  append(event: NewEvent): Promise<number>;
  /** Events with `seq > afterSeq`, ascending, at most `limit` (clamped to 1..1000). */
  replay(afterSeq: number, limit: number, sessionId?: string): Promise<readonly EventRecord[]>;
  /** Highest `seq` in the log, or 0 when empty. */
  head(): Promise<number>;
}

/** @module ports/persistence/screenshots — screenshot reference repository. */

import type { Page, ScreenshotListQuery } from './queries.ts';
import type { ScreenshotRecord } from './records.ts';

/** A screenshot joined with the tool that produced it. */
export interface ScreenshotListRow extends ScreenshotRecord {
  readonly tool: string | null;
}

/** Repository over `screenshots`. The parent `tool_calls` row must exist first (FK). */
export interface ScreenshotRepository {
  /** Inserts a screenshot reference; duplicate `eventId` is ignored. */
  insert(record: ScreenshotRecord): Promise<void>;
  /** Fetches one screenshot or `null`. */
  get(eventId: string): Promise<ScreenshotListRow | null>;
  /** Lists a session's screenshots newest first. */
  listBySession(sessionId: string, query: ScreenshotListQuery): Promise<Page<ScreenshotListRow>>;
}

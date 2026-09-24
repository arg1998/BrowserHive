/** @module ports/persistence/tool-calls — tool invocation fact table repository. */

import type { Page, ToolCallListQuery } from './queries.ts';
import type { ToolCallRecord } from './records.ts';

/** A tool call joined with its session slug and screenshot presence (list views). */
export interface ToolCallListRow extends ToolCallRecord {
  readonly sessionSlug: string | null;
  readonly hasScreenshot: boolean;
  /** The call's harness: its connection's, else its session's launch harness, else `unknown` (normalised). */
  readonly harness: string;
}

/** Repository over `tool_calls`. */
export interface ToolCallRepository {
  /** Inserts a tool call; duplicate `eventId` is ignored. */
  insert(record: ToolCallRecord): Promise<void>;
  /** Fetches one tool call or `null`. */
  get(eventId: string): Promise<ToolCallListRow | null>;
  /** Lists tool calls of one session, newest first by default. */
  listBySession(sessionId: string, query: ToolCallListQuery): Promise<Page<ToolCallListRow>>;
  /** Lists tool calls across sessions (`GET /tool-calls`). */
  listAll(query: ToolCallListQuery): Promise<Page<ToolCallListRow>>;
}

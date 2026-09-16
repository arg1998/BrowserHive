/** @module contracts/tools/attention — request_attention and get_attention_result contracts (http only) */
import { z } from 'zod';
import { AttentionMode } from '../enums/attention-mode.ts';
import { AttentionStatus } from '../enums/attention-status.ts';
import { annotations, SESSION_ERRORS, SINCE } from './shared.ts';
import { defineTool } from './types.ts';

/** Terminal statuses an attention tool can return (`pending` never leaves the server). */
export const AttentionOutcomeStatus = AttentionStatus.exclude(['pending']);

/**
 * Outcome shape of both attention tools. `message` / `resolved_by` are **omitted** when absent;
 * `resolved_at` is `null` until settled by an operator or the timer.
 */
export const AttentionOutcome = z.object({
  status: AttentionOutcomeStatus,
  message: z.string().optional(),
  resolved_by: z.string().optional(),
  resolved_at: z.number().nullable(),
  request_id: z.string(),
});
/** Parsed {@link AttentionOutcome}. */
export type AttentionOutcome = z.infer<typeof AttentionOutcome>;

/**
 * The floor sentence injected into `request_attention`'s description. `minWaitSeconds` is floored
 * and clamped at 0; `0` yields only the second sentence.
 */
export function requestAttentionFloorNote(minWaitSeconds: number): string {
  const floor = Math.max(0, Math.floor(minWaitSeconds));
  return floor > 0
    ? `The operator requires a minimum wait of ${floor}s — a smaller max_wait_seconds is automatically raised to it, so give a human enough time. Set max_wait_seconds to 0 to wait indefinitely (up to the server limit), which is best when a human may be away.`
    : 'Set max_wait_seconds to 0 to wait indefinitely (up to the server limit), which is best when ' +
        'a human may be away.';
}

/**
 * Full `request_attention` description for a given operator floor (seconds). The contract's static
 * `description` is the floor-0 form; the server renders this at registration (spec 02 §3.12).
 */
export function requestAttentionDescription(minWaitSeconds = 0): string {
  return `Flag a session for human attention and BLOCK until an operator resolves it in the admin dashboard, it times out, or it is cancelled. Both modes (takeover and notify) block until resolved — neither is fire-and-forget. Use when the agent is stuck on something only a human can do (CAPTCHA, interactive login, consent screen). ${requestAttentionFloorNote(minWaitSeconds)} Returns the operator decision { status, message?, resolved_by?, resolved_at, request_id }. http transport only.`;
}

/** `request_attention`: blocks until an operator settles it; throws `ATTENTION_REQUIRES_HTTP` under stdio. */
export const REQUEST_ATTENTION = defineTool({
  name: 'request_attention',
  title: 'Request attention',
  description: requestAttentionDescription(0),
  input: z.object({
    session_id: z.string(),
    reason: z.string().min(1),
    mode: AttentionMode.default('takeover').describe(
      'Both modes BLOCK until an operator resolves the request (neither is fire-and-forget). ' +
        "'takeover' lets the operator drive the session live; 'notify' is view-only — the operator " +
        'still acknowledges/resolves it without driving.',
    ),
    options: z.unknown().optional(),
    max_wait_seconds: z.number().int().nonnegative().optional(),
  }),
  output: AttentionOutcome,
  annotations: annotations(false, false, false, false),
  pack: 'attention',
  capability: 'attention',
  errors: ['ATTENTION_REQUIRES_HTTP', ...SESSION_ERRORS],
  since: SINCE,
});

/** `get_attention_result`: re-attach by id; unknown/foreign ids answer `rejected`, never throw. */
export const GET_ATTENTION_RESULT = defineTool({
  name: 'get_attention_result',
  title: 'Get attention result',
  description:
    'Retrieve the outcome of a prior request_attention by its request_id. Returns ' +
    'immediately if the request is already resolved/rejected/timed-out; otherwise BLOCKS like ' +
    'request_attention until it settles. Use to recover a decision after a dropped connection. ' +
    'http transport only.',
  input: z.object({ request_id: z.string() }),
  output: AttentionOutcome,
  annotations: annotations(true, false, true, false),
  pack: 'attention',
  capability: 'attention',
  errors: ['ATTENTION_REQUIRES_HTTP'],
  since: SINCE,
});

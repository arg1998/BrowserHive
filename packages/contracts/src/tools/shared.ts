/** @module contracts/tools/shared — parameter primitives and constants shared by every tool pack */
import { z } from 'zod';
import type { ToolAnnotations } from './types.ts';

/** Milliseconds; `0` = no timeout. 30 s default matches the Playwright default. */
export const Timeout = z.number().int().nonnegative().default(30_000);

/** Every page-targeting tool accepts an optional tab id; omitted ⇒ the active tab. */
export const TabId = z.string().optional();

/** A non-empty selector, with a stable validation message. */
export const Selector = z.string().min(1, 'selector must be non-empty');

/** Playwright's `waitUntil` enum, reused across navigation entry points. */
export const WaitUntil = z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']);
/** Union of {@link WaitUntil} values. */
export type WaitUntil = z.infer<typeof WaitUntil>;

/** Codes every session-bound tool can raise via the ownership/lease lookup. */
export const SESSION_ERRORS = [
  'SESSION_NOT_FOUND',
  'SESSION_DEAD',
  'SESSION_ACCESS_DENIED',
] as const;

/** Semver of first appearance for the 43 tools of the first release. */
export const SINCE = '0.1.0';

/**
 * Build a {@link ToolAnnotations} record positionally (readOnly, destructive, idempotent,
 * openWorld), matching the RO/D/I/OW columns of spec 02 §3.
 */
export function annotations(
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
): ToolAnnotations {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

/** Result of the `ok: true` acknowledgement tools that echo the selector. */
export const SelectorAck = z.object({
  session_id: z.string(),
  selector: z.string(),
  ok: z.literal(true),
});

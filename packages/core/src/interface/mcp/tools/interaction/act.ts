/** @module interface/mcp/tools/interaction/act — actionability mapping and humanize gating shared by the interaction tools. */

import type { Session } from '../../../../domain/session/session.ts';
import type { ToolCallContext } from '../../context.ts';
import { drive } from '../shared.ts';

/*
 * Humanization is opt-in per session; when off every interaction tool runs its exact native
 * Playwright call. `fill`, `drag_and_drop`, `select_option`, `press_key` and `scroll(to|selector)`
 * stay native even when it is on: `fill` means "set this value", a synthetic mouse sequence does not
 * reliably produce HTML5 drag events, and `select_option` drives a native popup no pointer reaches.
 */

/** True when the session types and points with human cadence. */
export function humanized(session: Session): boolean {
  return session.request.humanize;
}

/** Whether `evaluate` must opt out of Patchright's isolated world for this session. */
export function isolatedEvaluate(session: Session): boolean {
  return session.handle?.capabilities.isolatedEvaluate ?? false;
}

/**
 * Runs a page action and maps an actionability/timeout failure onto `ELEMENT_NOT_ACTIONABLE`
 * (selector + first line of the driver detail) — in the interaction tools only.
 */
export function act<T>(
  ctx: ToolCallContext,
  session: Session,
  selector: string,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  return drive(ctx, { selector, timeoutMs, sessionId: session.id }, run);
}

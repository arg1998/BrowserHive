/** @module interface/mcp/site-hold — the tool hold of a template session while a security intercept is open (spec 13 §9.3, §9.5): every tool but the ones that end or only inspect a session answers `SITE_OPERATOR_PENDING` with the request to wait for. */

import type { Session } from '../../domain/session/session.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { SiteHold } from '../../ports/security-intercepts.ts';

/** Tools a held template session may still call (spec 13 §9.5 "Outcome"). */
export const SITE_HOLD_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'close_session',
  'list_sessions',
  'server_status',
  'session_info',
  'list_tabs',
  'screenshot',
  'list_templates',
  'get_attention_result',
  'list_saved_auths',
  'vault_list_available',
]);

/** What the dispatcher asks: the open intercept holding a session, or `null`. */
export interface SiteHolds {
  holdOf(sessionId: string): SiteHold | null;
}

/** The agent-facing wait instruction of a held session. */
export function siteWaitText(requestId: string): string {
  return `Wait with get_attention_result('${requestId}'), or close the session.`;
}

/**
 * Refuses `tool` on a live template session that a security intercept holds.
 *
 * @throws AppError `SITE_OPERATOR_PENDING` `{session_id, site, request_id, reason, wait_text}`.
 */
export function assertNotSiteHeld(
  tool: string,
  session: Session | null,
  holds: SiteHolds | undefined,
): void {
  const template = session?.template;
  if (session == null || template == null || template.mode !== 'live' || holds === undefined) {
    return;
  }
  if (SITE_HOLD_EXEMPT_TOOLS.has(tool)) return;
  const hold = holds.holdOf(session.id);
  if (hold === null) return;
  const waitText = siteWaitText(hold.requestId);
  throw new AppError(
    'SITE_OPERATOR_PENDING',
    {
      session_id: session.id,
      site: hold.site,
      request_id: hold.requestId,
      reason: hold.reason,
      wait_text: waitText,
    },
    {
      publicMessage: `${hold.site} needs the operator before this session can continue (${hold.reason}). ${waitText}`,
    },
  );
}

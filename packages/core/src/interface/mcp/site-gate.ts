/** @module interface/mcp/site-gate — the site gate of a tool call on an agent's template session, before the browser is touched: the sign-in pause (D-60), the security hold (spec 13 §9.3, §9.5), then the site pack's stops and guards. A call that waited for a before-action strategy (spec 13 §9.4) passes it again right before it acts, so a queued action never runs on a site held, stopped or challenged meanwhile, nor during an operator sign-in. */

import type { Session } from '../../domain/session/session.ts';
import type { ToolServices } from './services.ts';
import { assertNotSiteHeld } from './site-hold.ts';

/** Tools a template session may call while its agents are paused (D-60): they end or only inspect a session. */
export const PAUSE_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'close_session',
  'list_sessions',
  'server_status',
  'session_info',
  'list_tabs',
  'list_templates',
  'get_attention_result',
  'request_attention',
  'list_saved_auths',
  'vault_list_available',
]);

/** One tool call the gate runs for. */
export interface SiteGateCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The session the ownership policy resolved, or `null` (the gate then does nothing). */
  readonly session: Session | null;
  readonly signal: AbortSignal;
}

/**
 * A call on a template session waits while the operator signs in to one of its sites (D-60);
 * reading tools and the ones that end or inspect a session do not.
 *
 * @throws AppError `TEMPLATE_UNAVAILABLE` (`paused`) when the bounded wait runs out
 */
export async function holdWhilePaused(
  services: Pick<ToolServices, 'templatePause'>,
  tool: string,
  session: Session | null,
  signal: AbortSignal,
): Promise<void> {
  const template = session?.template;
  const pause = services.templatePause;
  if (template == null || template.mode !== 'live' || pause === undefined) return;
  if (PAUSE_EXEMPT_TOOLS.has(tool)) return;
  await pause.wait(template.templateId, template.name, signal);
}

/**
 * The gate of one call; run it before the handler, and again after every wait before the browser
 * acts. Each run after the first acts only on guard decisions the earlier runs did not (no second
 * hit row, approval request or used one-time pass).
 *
 * @throws AppError `TEMPLATE_UNAVAILABLE` (`paused`), `SITE_OPERATOR_PENDING`, `URL_BLOCKED`,
 *   `SITE_ACTION_BLOCKED`
 */
export function siteGate(
  services: Pick<ToolServices, 'templatePause' | 'siteHolds' | 'siteGuards'>,
  call: SiteGateCall,
): () => Promise<void> {
  const { tool, args, session, signal } = call;
  let settled: ReadonlySet<string> | undefined;
  return async () => {
    await holdWhilePaused(services, tool, session, signal);
    assertNotSiteHeld(tool, session, services.siteHolds);
    const guards = services.siteGuards;
    if (session === null || guards === undefined) return;
    settled = await guards.beforeTool({ tool, args, session }, settled);
  };
}

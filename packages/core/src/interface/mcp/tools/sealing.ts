/** @module interface/mcp/tools/sealing — what sealing changes in the tools of a template session (spec 13 §5.4, D-51): cookie values hidden, cookie writes and state export refused. Checked per call, so a re-sealed template applies at once. */

import type { Session } from '../../../domain/session/session.ts';
import type { SessionSealing } from '../../../domain/templates/model.ts';
import type { AppError } from '../../../kernel/errors/app-error.ts';
import { registrableDomain } from '../../../kernel/url.ts';
import type { Cookie } from '../../../ports/browser-driver.ts';
import { registryError } from './shared.ts';

/** The flag of {@link SessionSealing} each refusable tool checks. */
const REFUSING_FLAG = {
  set_cookies: 'refuseCookieWrites',
  save_storage_state: 'refuseStateExport',
} as const satisfies Record<string, keyof SessionSealing>;

/**
 * Throws `SESSION_SEALED` when `session` is a template session whose principal may not use `tool`.
 *
 * @throws AppError `SESSION_SEALED` `{session_id, tool}`
 */
export function assertUnsealed(session: Session, tool: keyof typeof REFUSING_FLAG): void {
  const sealing = session.template?.sealing;
  if (sealing === undefined || !sealing[REFUSING_FLAG[tool]]) return;
  throw sessionSealed(session.id, tool);
}

/** `SESSION_SEALED` for `tool`. */
export function sessionSealed(sessionId: string, tool: string): AppError<'SESSION_SEALED'> {
  return registryError('SESSION_SEALED', { session_id: sessionId, tool });
}

/** The registrable domain of a cookie's `domain` (`.www.site-a.test` → `site-a.test`). */
function cookieSite(cookie: Cookie): string {
  return registrableDomain(cookie.domain.replace(/^\./, ''));
}

/**
 * `get_cookies` of a sealed session (spec 13 §5.4): only the cookies of the template's sites, each
 * with `value: ""` (name, domain, path, expiry and flags kept), or `null` when the session's
 * principal sees cookie values.
 */
export function sealedCookies(session: Session, cookies: readonly Cookie[]): Cookie[] | null {
  const template = session.template;
  if (template === null || !template.sealing.hideCookieValues) return null;
  const sites = new Set(template.sites.map((s) => s.site));
  return cookies.filter((c) => sites.has(cookieSite(c))).map((c) => ({ ...c, value: '' }));
}

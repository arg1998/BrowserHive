/** @module app/templates/prelaunch-report — what a launch tells its session after the pre-launch check (spec 13 §8.2): each site's status for `template.sites`, and the `TEMPLATE_SITE_SIGNED_OUT` warning when some sites are out. */

import type { Session } from '../../domain/session/session.ts';
import type { SessionService } from '../sessions/session-service.ts';
import type { PrelaunchOutcome } from './host-supervisor-types.ts';

/** The warning text (shown to operators; worded per spec 13 §5). */
export function signedOutWarning(sites: readonly string[]): string {
  return `Signed out of ${sites.join(', ')}; the operator has been asked to sign in again.`;
}

/** Updates the session's site statuses and warns about the sites that are out. */
export function reportPrelaunch(
  sessions: Pick<SessionService, 'warn'>,
  session: Session,
  outcome: PrelaunchOutcome,
): void {
  const current = session.template;
  if (current != null) {
    session.retemplate({
      sealing: current.sealing,
      sealed: current.sealed,
      sites: outcome.sites.map((s) => ({ site: s.site, status: s.status })),
    });
  }
  if (outcome.out.length === 0) return;
  sessions.warn(session, {
    code: 'TEMPLATE_SITE_SIGNED_OUT',
    sessionId: session.id,
    message: signedOutWarning(outcome.out),
    details: { sites: [...outcome.out] },
  });
}

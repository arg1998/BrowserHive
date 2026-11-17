/** @module app/site-packs/site-errors — the typed refusals of site pack enforcement on the tool path (spec 13 §12): `SITE_OPERATOR_PENDING`, `SITE_ACTION_BLOCKED` and a guard's `URL_BLOCKED`. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { AppError } from '../../kernel/errors/app-error.ts';

/** Why a session waits for the operator (`SITE_OPERATOR_PENDING.details.reason`). */
export type SitePendingReason = 'challenge' | 'write_confirm' | 'stopped';

/** The `wait_text` of a stopped site. */
export const STOPPED_WAIT_TEXT = 'Do not retry until the operator clears the site.';

/** The `wait_text` of an open request. */
export function waitText(requestId: string): string {
  return `Wait with get_attention_result('${requestId}'), or close the session.`;
}

/** `SITE_OPERATOR_PENDING` (409): an open request (`requestId`) or a stopped site (`null`). */
export function siteOperatorPending(
  sessionId: string,
  site: string,
  requestId: string | null,
  reason: SitePendingReason,
): AppError<'SITE_OPERATOR_PENDING'> {
  const details = {
    session_id: sessionId,
    site,
    request_id: requestId,
    reason,
    wait_text: requestId === null ? STOPPED_WAIT_TEXT : waitText(requestId),
  };
  return new AppError('SITE_OPERATOR_PENDING', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.SITE_OPERATOR_PENDING.message, details),
  });
}

/** `SITE_ACTION_BLOCKED` (403): the target is a guarded control; `guard` is `<pack id>#<guard id>`. */
export function siteActionBlocked(
  sessionId: string,
  site: string,
  guard: string,
): AppError<'SITE_ACTION_BLOCKED'> {
  const details = { session_id: sessionId, site, guard };
  return new AppError('SITE_ACTION_BLOCKED', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.SITE_ACTION_BLOCKED.message, details),
  });
}

/** `URL_BLOCKED` with `pattern: '<pack id>#<guard id>'` (a `GET` document guard, spec 13 §9.3). */
export function urlBlockedByGuard(url: string, pattern: string): AppError<'URL_BLOCKED'> {
  const details = { url, pattern };
  return new AppError('URL_BLOCKED', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.URL_BLOCKED.message, details),
  });
}

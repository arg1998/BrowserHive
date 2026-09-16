/** @module domain/session/warnings — SessionWarning: non-fatal per-session findings, codes from the registry's `warning` category (spec 10 §1). */

import { WARNING_ERRORS } from '@browserhive/contracts/errors';
import type { LaunchWarning } from '../../ports/browser-driver.ts';

/** Every `SessionWarning` code (registry category `warning`); logged at `warn`, never thrown. */
export type SessionWarningCode = keyof typeof WARNING_ERRORS;

/** The warning codes, in registry order. */
export const SESSION_WARNING_CODES: readonly SessionWarningCode[] = Object.keys(
  WARNING_ERRORS,
).filter((code): code is SessionWarningCode => code in WARNING_ERRORS);

/** True when `code` is a registered warning code. */
export function isSessionWarningCode(code: string): code is SessionWarningCode {
  return Object.hasOwn(WARNING_ERRORS, code);
}

/**
 * A non-fatal finding about one session (wire shape `{ code, session_id, message, details }`). Broadcast
 * on `session:<id>` as `session.warning`, logged at `warn`, kept on the aggregate for `session_info`.
 * `code` is widened to `string` for codes a driver adapter may emit before the registry learns them.
 */
export interface SessionWarning {
  readonly code: SessionWarningCode | (string & {});
  readonly sessionId: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Lifts a driver {@link LaunchWarning} onto a session. */
export function warningFromLaunch(sessionId: string, warning: LaunchWarning): SessionWarning {
  return {
    code: warning.code,
    sessionId,
    message: warning.message,
    ...(warning.details !== undefined && { details: warning.details }),
  };
}

/** Builds a warning with a registered code. */
export function sessionWarning(
  code: SessionWarningCode,
  sessionId: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): SessionWarning {
  return { code, sessionId, message, ...(details !== undefined && { details }) };
}

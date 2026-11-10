/** @module app/sessions/not-found — the one text an unknown and a foreign session share (D-09), so a caller cannot probe for sessions it does not own. */

import { AppError } from '../../kernel/errors/app-error.ts';

/** `SESSION_NOT_FOUND` or `SESSION_ACCESS_DENIED` with the identical public text. */
export function notFound(
  code: 'SESSION_NOT_FOUND' | 'SESSION_ACCESS_DENIED',
  sessionId: string,
): AppError {
  // `SESSION_ACCESS_DENIED` mirrors `SESSION_NOT_FOUND` text so a caller cannot probe for sessions it does not own.
  return new AppError(
    code,
    { session_id: sessionId },
    { publicMessage: `No browser session with id '${sessionId}'` },
  );
}

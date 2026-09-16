/** @module features/sessions/live/ws-error — the registry code of a failed socket command (the store wraps WS `error` frames with the server code in `details.code`) */
import { z } from 'zod';
import { toAppError } from '@/lib/api/errors.ts';

const WsDetails = z.object({ code: z.string() });

/** Server error code for a rejected command, falling back to the client-side code. */
export function commandErrorCode(error: unknown): string {
  const appError = toAppError(error);
  const details = WsDetails.safeParse(appError.details);
  return details.success ? details.data.code : appError.code;
}

/** @module app/site-packs/strategies/pace-busy — `TEMPLATE_BUSY` with `limit_kind: 'pace'` (spec 13 §12, lead decision 6): "Actions on <site> are being paced." The capacity and tab variants stay in `app/templates/template-admission.ts`. */

import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { TEMPLATE_BUSY_LIMIT_TEXT } from '@browserhive/contracts/tools';
import { AppError } from '../../../kernel/errors/app-error.ts';

/** The retry hint of a paced action. */
export const PACE_RETRY_AFTER_MS = 5_000;

/** `TEMPLATE_BUSY` (`pace`) for an action on `site` (the template's site id) of template `template`. */
export function templatePaced(
  template: string,
  site: string,
  retryAfterMs: number = PACE_RETRY_AFTER_MS,
): AppError<'TEMPLATE_BUSY'> {
  const details = {
    template,
    limit_kind: 'pace' as const,
    limit_text: TEMPLATE_BUSY_LIMIT_TEXT.pace(site),
    retry_after_ms: retryAfterMs,
    retry_after_s: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
  return new AppError('TEMPLATE_BUSY', details, {
    publicMessage: renderMessage(ERROR_REGISTRY.TEMPLATE_BUSY.message, details),
  });
}

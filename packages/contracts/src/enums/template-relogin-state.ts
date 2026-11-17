/** @module contracts/enums/template-relogin-state — TemplateReloginState enum: where a re-login stands (spec 13 §8.4). */

import { z } from 'zod';

/**
 * `queued`: asked for from a notification button, the window opens on **Show window**; `open`: the
 * window is open; `filling`: a vault fill runs; then one of the four endings.
 */
export const TemplateReloginState = z.enum([
  'queued',
  'open',
  'filling',
  'signed_in',
  'failed',
  'timed_out',
  'cancelled',
]);
/** Union of {@link TemplateReloginState} members. */
export type TemplateReloginState = z.infer<typeof TemplateReloginState>;

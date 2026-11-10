/** @module contracts/enums/template-health-state — TemplateHealthState enum: whether a template is signed in to one site (spec 13 §2.3, §8.1). */

import { z } from 'zod';

/** A site's sign-in state: `unknown` until the first probe, then one of the four probe outcomes. */
export const TemplateHealthState = z.enum([
  'unknown',
  'signed_in',
  'signed_out',
  'challenged',
  'inconclusive',
]);
/** Union of {@link TemplateHealthState} members. */
export type TemplateHealthState = z.infer<typeof TemplateHealthState>;

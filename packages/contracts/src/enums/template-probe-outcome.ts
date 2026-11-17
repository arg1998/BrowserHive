/** @module contracts/enums/template-probe-outcome — TemplateProbeOutcome enum: what one sign-in probe of a template site found (spec 13 §8.1). */

import { z } from 'zod';

/** The four outcomes of a probe; `challenged` arrives with navigation probes (T3a). */
export const TemplateProbeOutcome = z.enum([
  'signed_in',
  'signed_out',
  'challenged',
  'inconclusive',
]);
/** Union of {@link TemplateProbeOutcome} members. */
export type TemplateProbeOutcome = z.infer<typeof TemplateProbeOutcome>;

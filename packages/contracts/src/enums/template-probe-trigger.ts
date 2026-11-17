/** @module contracts/enums/template-probe-trigger — TemplateProbeTrigger enum: why a template site was probed (spec 13 §2.5 `template_probes.trigger`, §8.2, §8.3). */

import { z } from 'zod';

/** What started a probe; `restore` also covers a seed from a storage state (spec 13 §7.4). */
export const TemplateProbeTrigger = z.enum([
  'schedule',
  'prelaunch',
  'recording',
  'relogin',
  'manual',
  'host_start',
  'attention',
  'restore',
]);
/** Union of {@link TemplateProbeTrigger} members. */
export type TemplateProbeTrigger = z.infer<typeof TemplateProbeTrigger>;

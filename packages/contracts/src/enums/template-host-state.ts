/** @module contracts/enums/template-host-state — TemplateHostState enum: the state of a template's one browser (spec 13 §3.2). */

import { z } from 'zod';

/** State of a template host. Operator surfaces only: agents never see it (spec 13 §5). */
export const TemplateHostState = z.enum([
  'stopped',
  'starting',
  'running',
  'draining',
  'crashed',
  'failed',
]);
/** Union of {@link TemplateHostState} members. */
export type TemplateHostState = z.infer<typeof TemplateHostState>;

/** @module contracts/enums/template-availability — TemplateAvailability enum: what list_templates tells an agent about launching a template now (spec 13 §5.1). */

import { z } from 'zod';

/** `available` (a launch would be admitted now), `busy` (at capacity), `needs_login` (every enabled site is signed out or challenged), `unavailable` (not usable until the operator acts). */
export const TemplateAvailability = z.enum(['available', 'busy', 'needs_login', 'unavailable']);
/** Union of {@link TemplateAvailability} members. */
export type TemplateAvailability = z.infer<typeof TemplateAvailability>;

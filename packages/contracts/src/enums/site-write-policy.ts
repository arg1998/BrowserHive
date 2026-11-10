/** @module contracts/enums/site-write-policy — SiteWritePolicy enum: what happens to requests a site pack marks as writes (spec 13 §2.3, §9.3). */

import { z } from 'zod';

/** Per-site write policy; `null` on a template site means the pack's default. */
export const SiteWritePolicy = z.enum(['allow', 'warn', 'confirm']);
/** Union of {@link SiteWritePolicy} members. */
export type SiteWritePolicy = z.infer<typeof SiteWritePolicy>;

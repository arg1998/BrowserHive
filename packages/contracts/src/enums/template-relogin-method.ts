/** @module contracts/enums/template-relogin-method — TemplateReloginMethod enum: how a template site is signed in again (spec 13 §8.4). */

import { z } from 'zod';

/** `window`: the operator in a window on the BrowserHive machine; `vault`: a fill with a linked vault binding. */
export const TemplateReloginMethod = z.enum(['window', 'vault']);
/** Union of {@link TemplateReloginMethod} members. */
export type TemplateReloginMethod = z.infer<typeof TemplateReloginMethod>;

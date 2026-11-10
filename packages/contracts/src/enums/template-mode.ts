/** @module contracts/enums/template-mode — TemplateMode enum: how a session uses its template (spec 13 §2.5, §1.1). */

import { z } from 'zod';

/** `live`: an agent's virtual session; `maintenance`: BrowserHive's own session on a host (recording, re-login, probes), never an agent's. `serial` is reserved (spec 13 §16), so the column is an open set. */
export const TemplateMode = z.enum(['live', 'maintenance']);
/** Union of {@link TemplateMode} members. */
export type TemplateMode = z.infer<typeof TemplateMode>;

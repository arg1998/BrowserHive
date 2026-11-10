/** @module contracts/enums/template-status — TemplateStatus enum: the lifecycle of a session template (spec 13 §2.1, D-49). */

import { z } from 'zod';

/** A template is `recording` until its first Finish, `ready` once agents may launch it, `disabled` by the operator; only `ready` templates can be launched. */
export const TemplateStatus = z.enum(['recording', 'ready', 'disabled']);
/** Union of {@link TemplateStatus} members. */
export type TemplateStatus = z.infer<typeof TemplateStatus>;

/** @module contracts/enums/attention-mode — request_attention interaction modes */
import { z } from 'zod';

/**
 * How an operator may interact with a session while an attention request is open: `takeover` lets
 * the operator drive the page live, `notify` is view-only. Both modes block the agent.
 */
export const AttentionMode = z.enum(['takeover', 'notify']);
/** Union of {@link AttentionMode} values. */
export type AttentionMode = z.infer<typeof AttentionMode>;

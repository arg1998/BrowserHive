/** @module contracts/enums/attention-status — attention request lifecycle states */
import { z } from 'zod';

/** Lifecycle of an attention request: `pending` then exactly one terminal state. */
export const AttentionStatus = z.enum(['pending', 'resolved', 'rejected', 'timeout', 'cancelled']);
/** Union of {@link AttentionStatus} values. */
export type AttentionStatus = z.infer<typeof AttentionStatus>;

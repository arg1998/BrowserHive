/** @module contracts/enums/closed-reason — ClosedReason enum: Why a session left the `live` state. */

import { z } from 'zod';

/**
 * Why a session left the `live` state: `user` (agent close), `operator` (dashboard terminate), `lease_expired`, `crash`, `shutdown`, `interrupted`, or `launch_failed` (D-21 pipeline compensation).
 */
export const ClosedReason = z.enum([
  'user',
  'operator',
  'lease_expired',
  'crash',
  'shutdown',
  'interrupted',
  'launch_failed',
]);
/** Union of {@link ClosedReason} members. */
export type ClosedReason = z.infer<typeof ClosedReason>;

/** @module contracts/enums/tool-capability — ToolCapability enum: Coarse capability class of an MCP tool (spec 02 §2); drives recording, authorization and stats. */

import { z } from 'zod';

/**
 * Coarse capability class of an MCP tool (spec 02 §2); drives recording, authorization and stats.
 */
export const ToolCapability = z.enum([
  'read',
  'mutate',
  'navigate',
  'credential',
  'attention',
  'lifecycle',
]);
/** Union of {@link ToolCapability} members. */
export type ToolCapability = z.infer<typeof ToolCapability>;

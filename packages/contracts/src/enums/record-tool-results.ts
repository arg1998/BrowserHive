/** @module contracts/enums/record-tool-results — RecordToolResults enum: What of a tool result is persisted (D-20): `full` the capped text, `shape` key names and sizes, `none` sizes only. */

import { z } from 'zod';

/**
 * What of a tool result is persisted (D-20): `full` the capped text, `shape` key names and sizes, `none` sizes only.
 */
export const RecordToolResults = z.enum(['full', 'shape', 'none']);
/** Union of {@link RecordToolResults} members. */
export type RecordToolResults = z.infer<typeof RecordToolResults>;

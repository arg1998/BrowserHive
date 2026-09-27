/** @module contracts/enums/notification-content-level — NotificationContentLevel enum: How much of a notification a channel may carry (D-32): `counts` (kind, counts, session slug, links), `titles` (plus title, summary and structured fields) or `full`. */

import { z } from 'zod';

/**
 * How much of a notification a channel may carry (D-32): `counts` (kind, counts, session slug, links), `titles` (plus title, summary and structured fields) or `full`.
 */
export const NotificationContentLevel = z.enum(['counts', 'titles', 'full']);
/** Union of {@link NotificationContentLevel} members. */
export type NotificationContentLevel = z.infer<typeof NotificationContentLevel>;

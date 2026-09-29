/** @module contracts/enums/notification-state — NotificationState enum: Lifecycle state of a notification (D-32): `open` while it may still need someone, then `acted`, `resolved` or `expired`; `final` for one-shot facts. Actions exist only while `open`. */

import { z } from 'zod';

/**
 * Lifecycle state of a notification (D-32): `open` while it may still need someone, then `acted`, `resolved` or `expired`; `final` for one-shot facts. Actions exist only while `open`.
 */
export const NotificationState = z.enum(['open', 'acted', 'resolved', 'expired', 'final']);
/** Union of {@link NotificationState} members. */
export type NotificationState = z.infer<typeof NotificationState>;

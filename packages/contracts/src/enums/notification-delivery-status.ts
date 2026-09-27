/** @module contracts/enums/notification-delivery-status — NotificationDeliveryStatus enum: Status of one outbox job (`notification_deliveries.status`, D-34): `pending` → `sending` → `sent`, or `retrying` → `dead`; `suppressed` (with a reason) and `superseded` are terminal without a platform call. */

import { z } from 'zod';

/**
 * Status of one outbox job (`notification_deliveries.status`, D-34): `pending` → `sending` → `sent`, or `retrying` → `dead`; `suppressed` (with a reason) and `superseded` are terminal without a platform call.
 */
export const NotificationDeliveryStatus = z.enum([
  'pending',
  'sending',
  'sent',
  'retrying',
  'dead',
  'suppressed',
  'superseded',
]);
/** Union of {@link NotificationDeliveryStatus} members. */
export type NotificationDeliveryStatus = z.infer<typeof NotificationDeliveryStatus>;

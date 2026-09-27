/** @module contracts/enums/notification-delivery-op — NotificationDeliveryOp enum: Operation of one outbox job (`notification_deliveries.op`, D-34). */

import { z } from 'zod';

/**
 * Operation of one outbox job (`notification_deliveries.op`, D-34).
 */
export const NotificationDeliveryOp = z.enum(['send', 'edit', 'delete']);
/** Union of {@link NotificationDeliveryOp} members. */
export type NotificationDeliveryOp = z.infer<typeof NotificationDeliveryOp>;

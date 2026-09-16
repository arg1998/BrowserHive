/** @module contracts/enums/notification-type — NotificationType enum: Notification type (`notifications.type`, D-16); selects icon, colour and inbox filter. */

import { z } from 'zod';

/**
 * Notification type (`notifications.type`, D-16); selects icon, colour and inbox filter.
 */
export const NotificationType = z.enum(['attention', 'error', 'vault', 'lifecycle', 'system']);
/** Union of {@link NotificationType} members. */
export type NotificationType = z.infer<typeof NotificationType>;

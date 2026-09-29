/** @module contracts/enums/notification-channel-source — NotificationChannelSource enum: Where a notification channel is defined (D-39): the dashboard (`db`) or a `--notificationChannel` flag (`startup`, read-only). */

import { z } from 'zod';

/**
 * Where a notification channel is defined (D-39): the dashboard (`db`) or a `--notificationChannel` flag (`startup`, read-only).
 */
export const NotificationChannelSource = z.enum(['db', 'startup']);
/** Union of {@link NotificationChannelSource} members. */
export type NotificationChannelSource = z.infer<typeof NotificationChannelSource>;

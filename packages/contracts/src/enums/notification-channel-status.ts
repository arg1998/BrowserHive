/** @module contracts/enums/notification-channel-status — NotificationChannelStatus enum: Operational status of a notification channel (`notification_channels.status`, D-34): `paused` by the operator, `broken` by the circuit breaker. */

import { z } from 'zod';

/**
 * Operational status of a notification channel (`notification_channels.status`, D-34): `paused` by the operator, `broken` by the circuit breaker.
 */
export const NotificationChannelStatus = z.enum(['active', 'paused', 'broken']);
/** Union of {@link NotificationChannelStatus} members. */
export type NotificationChannelStatus = z.infer<typeof NotificationChannelStatus>;

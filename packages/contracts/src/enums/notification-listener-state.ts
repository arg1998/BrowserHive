/** @module contracts/enums/notification-listener-state — NotificationListenerState enum: State of a channel's press listener (Telegram poller, Discord gateway, ntfy reply subscription; D-41). */

import { z } from 'zod';

/** State of a channel's press listener (the Telegram poller, the Discord gateway, the ntfy reply subscription; D-41). */
export const NotificationListenerState = z.enum([
  'connecting',
  'connected',
  'reconnecting',
  'offline',
]);
/** Union of {@link NotificationListenerState} members. */
export type NotificationListenerState = z.infer<typeof NotificationListenerState>;

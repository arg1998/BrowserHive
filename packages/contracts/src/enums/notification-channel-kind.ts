/** @module contracts/enums/notification-channel-kind — NotificationChannelKind enum: Platform of a notification channel (03 §9.3). `in-app` is the built-in inbox; the rest are external. Open set: a platform is added without a schema rebuild. */

import { z } from 'zod';

/**
 * Platform of a notification channel (03 §9.3). `in-app` is the built-in inbox; the rest are external. Open set: a platform is added without a schema rebuild.
 */
export const NotificationChannelKind = z.enum([
  'in-app',
  'telegram',
  'discord',
  'ntfy',
  'webhook',
  'slack',
  'pushover',
  'teams',
  'apprise',
  'email',
]);
/** Union of {@link NotificationChannelKind} members. */
export type NotificationChannelKind = z.infer<typeof NotificationChannelKind>;

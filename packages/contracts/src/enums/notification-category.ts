/** @module contracts/enums/notification-category — NotificationCategory enum: Coarse group of a notification kind (D-32); drives channel presets, TTL and image rules. */

import { z } from 'zod';

/**
 * Coarse group of a notification kind (D-32); drives channel presets, TTL and image rules.
 */
export const NotificationCategory = z.enum([
  'needs-you',
  'problems',
  'wrap-ups',
  'reports',
  'system',
]);
/** Union of {@link NotificationCategory} members. */
export type NotificationCategory = z.infer<typeof NotificationCategory>;

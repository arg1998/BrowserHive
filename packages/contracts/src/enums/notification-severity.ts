/** @module contracts/enums/notification-severity — NotificationSeverity enum: severity of a notification (D-16, D-32), set by its producer; drives inbox styling, channel minimum-severity rules and platform priority. `critical` bypasses quiet hours. */

import { z } from 'zod';

/**
 * Severity of a notification (D-16, D-32), set by its producer; drives inbox styling, channel minimum-severity rules and platform priority. `critical` bypasses quiet hours.
 */
export const NotificationSeverity = z.enum(['info', 'warn', 'error', 'critical']);
/** Union of {@link NotificationSeverity} members. */
export type NotificationSeverity = z.infer<typeof NotificationSeverity>;

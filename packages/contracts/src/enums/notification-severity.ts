/** @module contracts/enums/notification-severity — NotificationSeverity enum: Severity of an in-app notification (D-16); derived from the producing bus event so the dashboard can style and sort the inbox. */

import { z } from 'zod';

/**
 * Severity of an in-app notification (D-16); derived from the producing bus event so the dashboard can style and sort the inbox.
 */
export const NotificationSeverity = z.enum(['info', 'warn', 'error']);
/** Union of {@link NotificationSeverity} members. */
export type NotificationSeverity = z.infer<typeof NotificationSeverity>;

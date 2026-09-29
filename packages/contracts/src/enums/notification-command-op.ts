/** @module contracts/enums/notification-command-op — NotificationCommandOp enum: Operation an `act` action asks BrowserHive to run when pressed in a chat (D-32); executed through the same services and scopes as the dashboard. */

import { z } from 'zod';

/**
 * Operation an `act` action asks BrowserHive to run when pressed in a chat (D-32); executed through the same services and scopes as the dashboard.
 */
export const NotificationCommandOp = z.enum([
  'attention.resolve',
  'vault.confirm.resolve',
  'session.extend_lease',
  'session.close',
]);
/** Union of {@link NotificationCommandOp} members. */
export type NotificationCommandOp = z.infer<typeof NotificationCommandOp>;

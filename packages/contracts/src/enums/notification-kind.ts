/** @module contracts/enums/notification-kind — NotificationKind enum: What a notification is about (D-32): the stable identity renderers, rules and presets branch on. Open set: new kinds are additive and consumers ignore kinds they do not know. */

import { z } from 'zod';

/**
 * What a notification is about (D-32): the stable identity renderers, rules and presets branch on. Open set: new kinds are additive and consumers ignore kinds they do not know.
 */
export const NotificationKind = z.enum([
  'attention.requested',
  'vault.confirm',
  'vault.filled',
  'session.finished',
  'session.crashed',
  'session.reaped',
  'tool.errors',
  'system.degraded',
  'channel.broken',
  'digest.daily',
  'digest.weekly',
  'report.anomaly',
  'test',
]);
/** Union of {@link NotificationKind} members. */
export type NotificationKind = z.infer<typeof NotificationKind>;

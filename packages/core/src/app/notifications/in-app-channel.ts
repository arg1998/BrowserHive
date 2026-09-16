/** @module app/notifications/in-app-channel — the built-in `NotificationChannel`: publishes `notification.created` on the bus for the WS `notifications` topic. */

import type { EventPublisher } from '../../ports/event-bus.ts';
import type { NotificationChannel } from '../../ports/notification-channel.ts';
import type { DomainEvents } from '../events/catalog.ts';

/** Name of the built-in channel. */
export const IN_APP_CHANNEL = 'in-app';

/**
 * Builds the in-app channel. External adapters (webhook, ntfy, Telegram, Slack, email) implement
 * the same port and are passed to the service alongside this one; none are built (D-16).
 *
 * @returns A channel that publishes `notification.created`.
 */
export function createInAppChannel(bus: EventPublisher<DomainEvents>): NotificationChannel {
  return {
    name: IN_APP_CHANNEL,
    send(payload) {
      bus.publish('notification.created', { type: 'notification.created', notification: payload });
    },
  };
}

/** @module app/notifications/in-app-channel — the built-in `NotificationChannel` (spec 03 §9.3): the dashboard inbox. `send` publishes `notification.created`, `edit` publishes `notification.updated`, for the WS `notifications` topic. Delivered inline after the commit, never through the outbox: the row is the delivery. */

import type { EventPublisher } from '../../ports/event-bus.ts';
import type {
  ChannelCapabilities,
  ChannelDelivery,
  ChannelSendResult,
  NotificationChannel,
} from '../../ports/notification-channel.ts';
import type { DomainEvents } from '../events/catalog.ts';

/** Id, name and kind of the built-in channel. */
export const IN_APP_CHANNEL = 'in-app';

/** The inbox renders everything the contract can express, without limits. */
export const IN_APP_CAPABILITIES: ChannelCapabilities = {
  richBlocks: true,
  tables: true,
  images: true,
  actButtons: true,
  openLinks: true,
  edit: true,
  delete: true,
  replies: false,
  deleteWindowMs: null,
  maxTitleChars: Number.MAX_SAFE_INTEGER,
  maxTextChars: Number.MAX_SAFE_INTEGER,
  maxButtons: Number.MAX_SAFE_INTEGER,
};

function inboxOf(delivery: ChannelDelivery) {
  if (delivery.inbox === undefined) throw new Error('in-app delivery without its inbox row');
  return delivery.inbox;
}

/**
 * Builds the in-app channel. External adapters implement the same port and are fed by the outbox
 * (D-34).
 *
 * @returns A channel whose message ref is the notification id.
 */
export function createInAppChannel(bus: EventPublisher<DomainEvents>): NotificationChannel {
  return {
    id: IN_APP_CHANNEL,
    name: IN_APP_CHANNEL,
    kind: IN_APP_CHANNEL,
    capabilities: IN_APP_CAPABILITIES,
    async send(delivery): Promise<ChannelSendResult> {
      const notification = inboxOf(delivery);
      bus.publish('notification.created', { type: 'notification.created', notification });
      return { ref: { notification_id: notification.notification_id } };
    },
    async edit(_ref, delivery): Promise<ChannelSendResult> {
      const notification = inboxOf(delivery);
      bus.publish('notification.updated', { type: 'notification.updated', notification });
      return { ref: { notification_id: notification.notification_id } };
    },
  };
}

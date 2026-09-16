/** @module ports/notification-channel — delivery seam for notifications (D-16): the in-app channel today; webhook, ntfy, Telegram, Slack, email adapters plug in here later. */

import type { Notification } from '@browserhive/contracts/http';

/**
 * One delivery target. `send` receives the persisted wire DTO after the row exists; it may be
 * async and may throw — the notification service isolates and logs channel failures, so a
 * failing external channel never blocks the in-app inbox.
 */
export interface NotificationChannel {
  /** Stable name for logs and future `notification_channels` rows (`in-app`, `webhook:ops`…). */
  readonly name: string;
  send(payload: Notification): Promise<void> | void;
}

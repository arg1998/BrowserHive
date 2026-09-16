/** @module app/notifications — public surface of the notification subsystem (D-16). */

export { createInAppChannel, IN_APP_CHANNEL } from './in-app-channel.ts';
export {
  DEDUP_WINDOW,
  NOTIFICATION_DAYS,
  NOTIFICATION_SEEN_DAYS,
  NotificationService,
  type NotificationServiceDeps,
  toNotification,
} from './notification-service.ts';
export {
  crashed,
  draftFor,
  NO_SESSION_LABEL,
  NOTIFICATION_GROUP_IDLE_MS,
  NOTIFICATION_GROUP_MAX_AGE_MS,
  type NotificationDraft,
  type NotificationGroup,
  PRODUCED_EVENTS,
  type ProducedEvent,
  type ProducedEventName,
  toolErrorsTitle,
} from './producers.ts';

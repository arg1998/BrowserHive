/** @module app/notifications — public surface of the notification subsystem (D-16, D-32, D-34): producers, the message contract builders, content levels, `degrade`, routing, the channel registry, the delivery outbox and the inbox service. */

export {
  NotificationActionListeners,
  type NotificationActionListenersDeps,
} from './action-listeners.ts';
export {
  type ActionCounter,
  type ActionExecutor,
  type ActionListInput,
  type ActionPage,
  actorOf,
  NotificationActionService,
  type NotificationActionServiceDeps,
  pressOrigin,
} from './actions.ts';
export {
  type ChannelAdapterFactory,
  type ChannelFactoryContext,
  ChannelRegistry,
  type ChannelRegistryDeps,
  type RegisteredChannel,
} from './channel-registry.ts';
export {
  ChannelService,
  type ChannelServiceDeps,
  capabilitiesDto,
  type DeliveryListInput,
  type DeliveryPage,
  TELEGRAM_CONNECT_MS,
  targetHint,
} from './channel-service.ts';
export { restrictContent } from './content-level.ts';
export { degrade, OPEN_IN_BROWSERHIVE } from './degrade.ts';
export {
  applyImageRule,
  type ImageVariants,
  imageVariants,
  wantsImages,
} from './images.ts';
export { createInAppChannel, IN_APP_CAPABILITIES, IN_APP_CHANNEL } from './in-app-channel.ts';
export { createLocalLinkBuilder, createPublicLinkBuilder, linkBuilderFor } from './links.ts';
export {
  type BuildMessageInput,
  bold,
  buildMessage,
  clip,
  code,
  decodeMessage,
  encodeMessage,
  formatDuration,
  type LifecycleChange,
  link,
  type MessageContent,
  reviseMessage,
  scrubMessage,
  text,
  time,
} from './message.ts';
export {
  DEDUP_WINDOW,
  NOTIFICATION_DAYS,
  NOTIFICATION_SEEN_DAYS,
  type NotificationScreenshots,
  NotificationService,
  type NotificationServiceDeps,
  toNotification,
} from './notification-service.ts';
export {
  DEFAULT_OUTBOX_OPTIONS,
  type DeliveryCounter,
  NotificationOutbox,
  type NotificationOutboxDeps,
  type OutboxOptions,
  type OutboxPass,
} from './outbox.ts';
export {
  crashed,
  draftFor,
  type ImageRequest,
  NO_SESSION_LABEL,
  NOTIFICATION_GROUP_IDLE_MS,
  NOTIFICATION_GROUP_MAX_AGE_MS,
  type NotificationDraft,
  type NotificationGroup,
  PRODUCED_EVENTS,
  type ProducedEvent,
  type ProducedEventName,
  requestSettled,
  revisionFor,
  type SettledRequestFacts,
  type ThreadRevision,
  toolErrorsTitle,
} from './producers.ts';
export {
  classifyPublicUrlProbe,
  isInsecurePublicUrl,
  PUBLIC_URL_CACHE_MS,
  PUBLIC_URL_PROBE_TIMEOUT_MS,
  PublicUrlChecker,
  type PublicUrlCheckerDeps,
  type PublicUrlVerdict,
  publicUrlHost,
  publicUrlOrigin,
} from './public-url.ts';
export {
  contentLevelOf,
  deleteWhenResolved,
  expiryFor,
  inQuietHours,
  localMinutes,
  planDeliveries,
  type RoutableChannel,
  type RouteDecision,
  route,
} from './routing.ts';
export {
  SAMPLE_IMAGE_REF,
  SAMPLE_NOTIFICATION_ID,
  SAMPLE_NOW,
  SAMPLE_SESSION_ID,
  type SampleOptions,
  sampleMessage,
} from './samples.ts';

/** @module contracts/notifications/channel — the stored shape of a notification channel's rules, target and secret references (spec 03 §9.3, D-33, D-35, D-39). */

import { z } from 'zod';
import { NotificationCategory } from '../enums/notification-category.ts';
import { NotificationChannelKind } from '../enums/notification-channel-kind.ts';
import { NotificationContentLevel } from '../enums/notification-content-level.ts';
import { NotificationSeverity } from '../enums/notification-severity.ts';

/** Prefix the config loader reserves; a channel secret may not be read from such a variable (D-33). */
export const RESERVED_ENV_PREFIX = 'BROWSERHIVE_';

/** Name of a notification channel: lowercase slug, unique across dashboard and startup channels. */
export const NotificationChannelName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'a lowercase name of up to 32 letters, digits and dashes');
/** Channel name. */
export type NotificationChannelName = z.infer<typeof NotificationChannelName>;

/**
 * The name of an environment variable that holds a channel secret. Values are never stored (D-33):
 * the database, the API and startup flags carry only the name.
 */
export const SecretEnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'an environment variable name')
  .max(128)
  .refine((name) => !name.startsWith(RESERVED_ENV_PREFIX), {
    message: `names starting with ${RESERVED_ENV_PREFIX} are reserved for configuration`,
  });
/** An environment variable name. */
export type SecretEnvName = z.infer<typeof SecretEnvName>;

/** `HH:MM` on a 24-hour clock. */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 22:00');

/** Hours during which only `critical` notifications are delivered; `start > end` spans midnight. */
export const QuietHours = z.object({
  start: ClockTime,
  end: ClockTime,
  /** IANA time zone (`Europe/Berlin`); absent = the host's zone. */
  time_zone: z.string().min(1).max(64).optional(),
});
/** Quiet hours. */
export type QuietHours = z.infer<typeof QuietHours>;

const PerCategory = <T extends z.ZodType>(value: T) => z.partialRecord(NotificationCategory, value);

/**
 * What a channel receives and how (`notification_channels.rules_json`). Every key is optional:
 * absent means "no restriction" or the documented default. Unknown keys are dropped on read, so a
 * newer release's rules never break an older reader.
 */
export const NotificationChannelRules = z.object({
  /** Categories delivered; absent = all. */
  categories: z.array(NotificationCategory).optional(),
  /** Minimum severity delivered; absent = `info`. */
  min_severity: NotificationSeverity.optional(),
  /** Session slug globs (`checkout-*`); absent = every session and session-less notifications. */
  sessions: z.array(z.string().min(1).max(64)).max(32).optional(),
  /** Harness slugs (`claude-code`); absent = any. Self-reported, routing only (D-30). */
  harness: z.array(z.string().min(1).max(32)).max(32).optional(),
  quiet_hours: QuietHours.optional(),
  /** Content level; absent = `titles`. */
  content: NotificationContentLevel.optional(),
  /** Screenshots per category (D-36); absent = off. */
  images: PerCategory(z.boolean()).optional(),
  /** Message TTL per category in milliseconds (D-35); absent = never. */
  ttl_ms: PerCategory(z.number().int().positive()).optional(),
  /** Delete the message once its notification is resolved, per category; absent = off. */
  delete_when_resolved: PerCategory(z.boolean()).optional(),
  /** Whether act buttons are offered (only where the platform supports them); absent = off. */
  act_buttons: z.boolean().optional(),
  /** Platform user ids allowed to press act buttons (N2). */
  allow_list: z.array(z.string().min(1).max(64)).max(32).optional(),
});
/** Channel rules. */
export type NotificationChannelRules = z.infer<typeof NotificationChannelRules>;

/** Content level used when a channel's rules do not set one. */
export const DEFAULT_CONTENT_LEVEL = 'titles' as const satisfies NotificationContentLevel;

/** Non-secret coordinates of a channel (chat id, topic, server URL), per kind. */
export const NotificationChannelTarget = z.record(z.string().max(64), z.string().max(2048));
/** Channel target. */
export type NotificationChannelTarget = z.infer<typeof NotificationChannelTarget>;

/** Secret parameter → environment variable name (`{ token: 'BH_TG_TOKEN' }`). */
export const NotificationChannelSecretRefs = z.record(z.string().max(64), SecretEnvName);
/** Secret references. */
export type NotificationChannelSecretRefs = z.infer<typeof NotificationChannelSecretRefs>;

/**
 * A channel declared by `--notificationChannel` (spec 08 §5.7), after parsing. Projected into
 * `notification_channels` with `source = 'startup'` at each start (D-39).
 */
export const StartupNotificationChannel = z.object({
  name: NotificationChannelName,
  kind: NotificationChannelKind.exclude(['in-app']),
  /** Discord: `webhook` or `bot` (D-38); `null` elsewhere. */
  mode: z.string().max(32).nullable(),
  target: NotificationChannelTarget,
  secret_refs: NotificationChannelSecretRefs,
  rules: NotificationChannelRules,
});
/** A parsed startup channel. */
export type StartupNotificationChannel = z.infer<typeof StartupNotificationChannel>;

/** Reasons recorded on a `suppressed` delivery (D-34); the delivery log explains each. */
export const SUPPRESSION_REASONS = [
  'filtered',
  'quiet_hours',
  'throttled',
  'channel_paused',
  'content_blocked',
  'image_blocked',
  'edit_unsupported',
  'delete_unsupported',
  'no_adapter',
] as const;
/** A suppression reason. */
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

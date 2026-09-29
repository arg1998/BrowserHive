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
 * Whether `name` is a time zone the runtime knows (`Intl`).
 *
 * @returns True for a known IANA zone (or `UTC`).
 */
export function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Days of the week, as a weekly digest names them. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** A day of the week. */
export const Weekday = z.enum(WEEKDAYS);
/** A day of the week. */
export type Weekday = z.infer<typeof Weekday>;

/** Time a daily digest is sent when none is chosen. */
export const DEFAULT_DIGEST_AT = '09:00';
/** Time a weekly digest is sent when none is chosen (D-43). */
export const DEFAULT_WEEKLY_DIGEST_AT = '17:00';
/** Day a weekly digest is sent when none is chosen (D-43). */
export const DEFAULT_DIGEST_DAY: Weekday = 'fri';

/**
 * A scheduled digest (D-43): every day (with `weekdays_only`, Monday to Friday) or every week (on
 * `day`, default Friday) at `at`, in the channel's time zone. The report covers the period that
 * ends at that time: with weekdays only, Monday's covers the weekend.
 */
export const DigestRule = z.object({
  every: z.enum(['day', 'week']),
  at: ClockTime,
  day: Weekday.optional(),
  weekdays_only: z.boolean().optional(),
});
/** A scheduled digest. */
export type DigestRule = z.infer<typeof DigestRule>;

/** The weekday a weekly digest runs on (its `day`, default Friday). */
export function digestDay(rule: Pick<DigestRule, 'day'>): Weekday {
  return rule.day ?? DEFAULT_DIGEST_DAY;
}

/**
 * The rule a frequency starts with: every day at 09:00, every week on Friday at 17:00 (D-43).
 *
 * @returns A new rule.
 */
export function defaultDigest(every: DigestRule['every']): DigestRule {
  return every === 'week'
    ? { every: 'week', at: DEFAULT_WEEKLY_DIGEST_AT, day: DEFAULT_DIGEST_DAY }
    : { every: 'day', at: DEFAULT_DIGEST_AT };
}

/**
 * The hourly anomaly checks (D-44). Each key is a threshold (or a switch); absent = its default
 * ({@link ANOMALY_DEFAULTS}); `null` (or `false`) switches that check off.
 */
export const AnomalyRule = z.object({
  /** Percent of failed tool calls in the last hour. */
  error_rate: z.number().min(1).max(100).nullable().optional(),
  /** Calls needed before the error rate counts. */
  min_calls: z.number().int().min(1).max(100_000).optional(),
  /** Minutes an attention request may wait. */
  attention_minutes: z.number().int().min(1).max(10_080).nullable().optional(),
  /** Blocked requests this many times the hourly average of the 24 hours before. */
  blocked_spike: z.number().min(1.5).max(1000).nullable().optional(),
  /** Blocked requests needed before a spike counts. */
  blocked_min: z.number().int().min(1).max(1_000_000).optional(),
  /** Live sessions at `maxSessions`. */
  capacity: z.boolean().optional(),
  /** An unresolved error-severity system event. */
  degraded: z.boolean().optional(),
});
/** The anomaly checks. */
export type AnomalyRule = z.infer<typeof AnomalyRule>;

/** Thresholds used when a channel's `anomaly` rule leaves a key out (D-44). */
export const ANOMALY_DEFAULTS = {
  error_rate: 20,
  min_calls: 20,
  attention_minutes: 30,
  blocked_spike: 3,
  blocked_min: 50,
  capacity: true,
  degraded: true,
} as const;

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
  /**
   * The channel's IANA time zone for its reports and quiet hours (`quiet_hours.time_zone` still
   * wins for quiet hours); absent = the host's zone (D-43).
   */
  time_zone: z.string().min(1).max(64).optional(),
  /** A scheduled digest (D-43); absent = none. */
  digest: DigestRule.optional(),
  /** Hourly anomaly alerts (D-44); absent = off. */
  anomaly: AnomalyRule.optional(),
  /** Content level; absent = `titles`. */
  content: NotificationContentLevel.optional(),
  /** Screenshots per category (D-36); absent = off. */
  images: PerCategory(z.boolean()).optional(),
  /**
   * Screenshots for this channel have their form fields masked (Playwright `mask`); absent = off.
   * A stored frame (a crash's last screenshot) cannot be masked, so such a channel gets none.
   */
  mask_images: z.boolean().optional(),
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
  'empty',
] as const;
/** A suppression reason. */
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * The in-app reports (D-45): a digest schedule and the anomaly switch for the dashboard itself,
 * with no external channel. The same keys as a channel's report rules; `{}` = off (the default).
 */
export const ReportSettings = z.strictObject({
  /** The in-app digest; absent = off. */
  digest: DigestRule.optional(),
  /** The in-app anomaly alerts (their thresholds); absent = off. */
  anomaly: AnomalyRule.optional(),
  /** The IANA zone of the in-app reports; absent = the host's. */
  time_zone: z.string().min(1).max(64).optional(),
});
/** The in-app reports. */
export type ReportSettings = z.infer<typeof ReportSettings>;

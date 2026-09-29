/** @module app/notifications/routing — pure channel routing (spec 03 §9.4, D-34, D-35): whether a message goes to a channel under its rules, quiet hours in the channel's time zone, TTL deadlines, and the outbox rows planned for one notification change. */

import {
  DEFAULT_CONTENT_LEVEL,
  IN_APP_ONLY_KINDS,
  type NotificationChannelRules,
  type NotificationMessage,
  type QuietHours,
  type SuppressionReason,
} from '@browserhive/contracts/notifications';
import { matchesGlob } from '../../kernel/glob.ts';
import type { ChannelCapabilities } from '../../ports/notification-channel.ts';
import type {
  NewNotificationDelivery,
  NotificationChannelRecord,
} from '../../ports/persistence/records.ts';

/** Severities in increasing order. */
const SEVERITY_RANK = { info: 0, warn: 1, error: 2, critical: 3 } as const;

/** A channel as the planner sees it: its row and its adapter's capabilities (`null` without an adapter). */
export interface RoutableChannel {
  readonly record: NotificationChannelRecord;
  readonly capabilities: ChannelCapabilities | null;
}

/** Outcome of the rules for one channel. */
export type RouteDecision =
  | { readonly deliver: true }
  | { readonly deliver: false; readonly reason: SuppressionReason };

/**
 * Minutes after local midnight of `now` in `timeZone` (IANA; `undefined` = the host's zone). DST
 * is handled by `Intl`: the wall clock is what counts.
 *
 * @returns 0..1439.
 */
export function localMinutes(now: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone !== undefined && { timeZone }),
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hour % 24) * 60 + minute;
}

function minutesOf(clock: string): number {
  const [h = '0', m = '0'] = clock.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Whether `now` falls inside quiet hours: `[start, end)` on the channel's wall clock; a window
 * whose start is after its end spans midnight; an empty window (`start == end`) is never quiet.
 * An unknown time zone falls back to the host's zone rather than silencing a channel.
 *
 * @returns True inside the window.
 */
export function inQuietHours(now: number, hours: QuietHours): boolean {
  let at: number;
  try {
    at = localMinutes(now, hours.time_zone);
  } catch {
    at = localMinutes(now);
  }
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  if (start === end) return false;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/**
 * A channel's quiet hours in its zone: `quiet_hours.time_zone`, else the channel's `time_zone`
 * (D-43), else the host's.
 *
 * @returns The hours with their zone, or `null` without quiet hours.
 */
export function quietHoursOf(rules: NotificationChannelRules): QuietHours | null {
  const hours = rules.quiet_hours;
  if (hours === undefined) return null;
  const zone = hours.time_zone ?? rules.time_zone;
  return zone === undefined ? hours : { ...hours, time_zone: zone };
}

/**
 * Applies a channel's rules to a message. Category, minimum severity, session globs and harness
 * filter everything; quiet hours hold back only alerting revisions below `critical` (a silent
 * edit is never held).
 *
 * @returns Deliver, or the suppression reason for the delivery log.
 */
export function route(
  rules: NotificationChannelRules,
  message: NotificationMessage,
  now: number,
): RouteDecision {
  if (rules.categories !== undefined && !rules.categories.includes(message.category)) {
    return { deliver: false, reason: 'filtered' };
  }
  if (
    rules.min_severity !== undefined &&
    SEVERITY_RANK[message.severity] < SEVERITY_RANK[rules.min_severity]
  ) {
    return { deliver: false, reason: 'filtered' };
  }
  if (rules.sessions !== undefined && rules.sessions.length > 0) {
    const slug = message.entities.session_slug;
    if (slug === undefined || !rules.sessions.some((g) => matchesGlob(slug, g))) {
      return { deliver: false, reason: 'filtered' };
    }
  }
  if (rules.harness !== undefined && rules.harness.length > 0) {
    const harness = message.entities.harness;
    if (harness === undefined || !rules.harness.includes(harness)) {
      return { deliver: false, reason: 'filtered' };
    }
  }
  const quiet = quietHoursOf(rules);
  if (
    quiet !== null &&
    message.alert &&
    message.severity !== 'critical' &&
    inQuietHours(now, quiet)
  ) {
    return { deliver: false, reason: 'quiet_hours' };
  }
  return { deliver: true };
}

/**
 * TTL deadline of a message sent at `sentAt` (D-35): the channel's TTL for the category, or
 * `null` (never, the default).
 *
 * @returns Epoch ms, or `null`.
 */
export function expiryFor(
  rules: NotificationChannelRules,
  message: Pick<NotificationMessage, 'category'>,
  sentAt: number,
): number | null {
  const ttl = rules.ttl_ms?.[message.category];
  return ttl === undefined ? null : sentAt + ttl;
}

/**
 * Whether a message should be deleted now because its notification left `open` and the channel
 * deletes resolved messages of that category (off by default, D-35).
 *
 * @returns True to set `expires_at = now`.
 */
export function deleteWhenResolved(
  rules: NotificationChannelRules,
  message: Pick<NotificationMessage, 'category' | 'state'>,
): boolean {
  return message.state !== 'open' && rules.delete_when_resolved?.[message.category] === true;
}

/** Content level a channel delivers at. */
export function contentLevelOf(rules: NotificationChannelRules) {
  return rules.content ?? DEFAULT_CONTENT_LEVEL;
}

/**
 * The outbox rows for one notification change (spec 03 §9.4): per external channel, a pending
 * `send` (first revision, or an alerting revision on a platform that cannot edit), a pending
 * `edit` (later revisions), or a `suppressed` row with its reason. In-app-only kinds produce no
 * rows at all (the D-34 loop cut). An **addressed** notification (a scheduled report, spec 03 §9.7)
 * is planned for its one channel only, and that channel's filters and quiet hours do not apply
 * (the schedule is the opt-in, D-43). Pure: the caller writes the rows in the notification's
 * transaction.
 *
 * @returns The rows to enqueue (empty with no external channel).
 */
export function planDeliveries(
  message: NotificationMessage,
  channels: readonly RoutableChannel[],
  now: number,
  addressedTo?: string,
): NewNotificationDelivery[] {
  if (channels.length === 0 || IN_APP_ONLY_KINDS.has(message.kind)) return [];
  const rows: NewNotificationDelivery[] = [];
  const targets =
    addressedTo === undefined
      ? channels
      : channels.filter((c) => c.record.channelId === addressedTo);
  for (const { record, capabilities } of targets) {
    const first = message.revision === 1;
    const base = {
      channelId: record.channelId,
      notificationId: message.id,
      revision: message.revision,
      createdAt: now,
    };
    const suppressed = (op: 'send' | 'edit', reason: SuppressionReason) =>
      rows.push({ ...base, op, status: 'suppressed', reason, nextAttemptAt: null });
    const op: 'send' | 'edit' =
      first || (capabilities !== null && !capabilities.edit && message.alert) ? 'send' : 'edit';
    if (record.status !== 'active') {
      suppressed(op, 'channel_paused');
      continue;
    }
    if (capabilities === null) {
      suppressed(op, 'no_adapter');
      continue;
    }
    const decision: RouteDecision =
      addressedTo === undefined ? route(record.rules, message, now) : { deliver: true };
    if (!decision.deliver) {
      suppressed(op, decision.reason);
      continue;
    }
    if (!first && !capabilities.edit && !message.alert) {
      suppressed('edit', 'edit_unsupported');
      continue;
    }
    rows.push({ ...base, op, status: 'pending', reason: null, nextAttemptAt: now });
  }
  return rows;
}

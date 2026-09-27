/** @module features/notifications/notification-meta — what a notification row says besides its title: the session it is about, for a folded group when it started, and the outcome once a request is no longer open; shared by the inbox rows and the topbar bell */
import type { NotificationKind, NotificationState } from '@browserhive/contracts/enums';
import type { Notification } from '@browserhive/contracts/http';
import { sessionSlug } from '@/lib/format/ids.ts';
import { formatAbsoluteShort } from '@/lib/format/time.ts';

/** The session a notification is about, by slug (`null` when it has none). */
export function notificationSession(n: Notification): string | null {
  if (n.session_id === null) return null;
  return n.session_slug ?? sessionSlug(n.session_id);
}

/**
 * Meta line parts: the session (unless the title already leads with it, as grouped tool errors do)
 * and, for a folded group, when its first occurrence happened.
 */
export function notificationMeta(n: Notification): readonly string[] {
  const parts: string[] = [];
  const slug = notificationSession(n);
  if (slug !== null && !n.title.startsWith(`${slug} ·`)) parts.push(slug);
  if (n.count > 1) parts.push(`first ${formatAbsoluteShort(n.created_at)}`);
  return parts;
}

/** States that earn an outcome pill (spec 04 §12.11). */
const OUTCOME_STATES: ReadonlySet<NotificationState> = new Set(['acted', 'resolved', 'expired']);
/** Kinds that announce an operator request: their `final` means the request was cancelled. */
const REQUEST_KINDS: ReadonlySet<NotificationKind> = new Set([
  'attention.requested',
  'vault.confirm',
]);

/**
 * The lifecycle state to show as a pill, or `null`: only once a request's notification left
 * `open` (resolved, expired, in progress, or closed when the request was cancelled). `open` and
 * one-shot `final` facts (a crash) show nothing.
 */
export function notificationOutcome(
  n: Pick<Notification, 'state' | 'kind'>,
): NotificationState | null {
  if (OUTCOME_STATES.has(n.state)) return n.state;
  return n.state === 'final' && REQUEST_KINDS.has(n.kind) ? 'final' : null;
}

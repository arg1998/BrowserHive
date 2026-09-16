/** @module features/notifications/notification-meta — what a notification row says besides its title: the session it is about and, for a folded group, when it started; shared by the inbox rows and the topbar bell */
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

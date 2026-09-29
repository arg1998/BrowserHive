/** @module app/notifications/content-level — `restrictContent(message, level)`: the per-channel content levels of D-32 (`counts` < `titles` < `full`), applied by the core before any adapter sees a message. Pure. */

import type { NotificationContentLevel } from '@browserhive/contracts/enums';
import { KIND_LABEL, type NotificationMessage } from '@browserhive/contracts/notifications';

/** Order of the levels, least to most revealing. */
const RANK: { readonly [L in NotificationContentLevel]: number } = {
  counts: 0,
  titles: 1,
  full: 2,
};

/**
 * Restricts a message to what `level` may carry (spec 03 §9.2):
 * - `full`: unchanged;
 * - `titles`: title, summary, `fields` and `footer` blocks, actions and entities (no quotes, code,
 *   tables, lists, images or paragraphs, where free text and screenshots live);
 * - `counts`: the kind's generic title (with the group count when the title had one), the session
 *   slug as the summary, no blocks, the actions, and only the session entities.
 * A message already at a lower level is never raised, and one already at `level` is returned as it
 * is: a report is built at its channel's level by its producer (spec 03 §9.7).
 *
 * @returns The restricted message.
 */
export function restrictContent(
  message: NotificationMessage,
  level: NotificationContentLevel,
): NotificationMessage {
  const target = RANK[level] < RANK[message.privacy.level] ? level : message.privacy.level;
  if (target === 'full' || target === message.privacy.level) return message;
  if (target === 'titles') {
    const blocks = message.blocks.filter((b) => b.type === 'fields' || b.type === 'footer');
    return { ...message, blocks, privacy: { level: 'titles', has_image: false } };
  }
  const count = /(\d+) tool errors?$/.exec(message.title)?.[1];
  const label = KIND_LABEL[message.kind];
  const slug = message.entities.session_slug;
  return {
    ...message,
    title: count === undefined || count === '1' ? label : `${label} (${count})`,
    summary: slug === undefined ? '' : `Session ${slug}`,
    blocks: [],
    entities: {
      ...(message.entities.session_id !== undefined && { session_id: message.entities.session_id }),
      ...(slug !== undefined && { session_slug: slug }),
    },
    privacy: { level: 'counts', has_image: false },
  };
}

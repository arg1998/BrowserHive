/** @module lib/format/ids — identifier truncation and session id parsing (one truncation rule: 8/6, spec 04 §11) */
import { parseSessionId } from '@browserhive/contracts/ids';

/** Middle-truncate an id keeping `head` and `tail` characters (`shop-a1b2…c3d4`). */
export function truncateId(id: string, head = 8, tail = 6): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(id.length - tail)}`;
}

/** The human slug of a session id, or the id itself when it does not parse. */
export function sessionSlug(id: string): string {
  return parseSessionId(id)?.slug ?? id;
}

/** Short display form of a session id: the slug plus the random suffix. */
export function sessionShort(id: string): string {
  const parsed = parseSessionId(id);
  return parsed === null ? truncateId(id) : `${parsed.slug}-${parsed.suffix}`;
}

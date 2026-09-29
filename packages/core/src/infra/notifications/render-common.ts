/** @module infra/notifications/render-common — pure helpers the platform renderers share (spec 03 §9.5): severity marks, UTC time text, absolute links, the screenshot block and the quote that only repeats the summary. */

import type { Block, Inline, NotificationMessage } from '@browserhive/contracts/notifications';
import type { LinkBuilder } from '../../ports/notification-channel.ts';

/** Label that introduces links which only open on the computer running BrowserHive (D-37). */
export const LOCAL_LINKS_LABEL = 'Open on this computer';
/** Wire name of an attached screenshot. */
export const SCREENSHOT_FILENAME = 'screenshot.jpg';

/** The leading mark of a message: its outcome once settled, a chart for a digest, else its severity. */
export function severityMark(
  message: Pick<NotificationMessage, 'severity' | 'state'> & { readonly kind?: string },
): string {
  if (message.state === 'resolved') return '✅';
  if (message.kind?.startsWith('digest.') === true) return '📊';
  if (message.state === 'expired') return '⌛';
  if (message.state === 'acted') return '👤';
  switch (message.severity) {
    case 'info':
      return 'ℹ️';
    case 'warn':
      return '⚠️';
    case 'error':
      return '🔴';
    case 'critical':
      return '🚨';
  }
}

/**
 * `HH:MM UTC` of an instant, or `YYYY-MM-DD HH:MM UTC` when `withDate` (the fallback text when a
 * platform cannot localise a time).
 *
 * @returns The text.
 */
export function utcTime(at: number, withDate = false): string {
  const iso = new Date(at).toISOString();
  const hm = iso.slice(11, 16);
  return withDate ? `${iso.slice(0, 10)} ${hm} UTC` : `${hm} UTC`;
}

/** One open link, absolute. */
export interface ResolvedLink {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly style: 'primary' | 'danger' | 'default';
}

/** The open actions of a (degraded) message as absolute links. */
export function openLinks(message: NotificationMessage, links: LinkBuilder): ResolvedLink[] {
  const out: ResolvedLink[] = [];
  for (const action of message.actions) {
    if (action.kind !== 'open') continue;
    out.push({
      id: action.id,
      label: action.label,
      url: links.url(action.path),
      style: action.style,
    });
  }
  return out;
}

/** The first screenshot block, if any. */
export function firstImage(message: NotificationMessage): Extract<Block, { type: 'image' }> | null {
  for (const block of message.blocks) if (block.type === 'image') return block;
  return null;
}

/** Plain text of an inline run (times as UTC text, links as their label). */
export function plainRun(run: readonly Inline[]): string {
  return run.map((node) => (node.type === 'time' ? utcTime(node.at) : node.text)).join('');
}

/**
 * The blocks worth rendering: screenshots are carried separately, and a collapsible quote whose
 * text the summary already starts with is dropped (attention requests quote their reason, which
 * is also the start of the summary).
 *
 * @returns The blocks, in order.
 */
export function bodyBlocks(message: NotificationMessage): Block[] {
  const summary = message.summary.trim();
  return message.blocks.filter((block) => {
    if (block.type === 'image') return false;
    if (block.type === 'quote' && block.collapsible) {
      const quoted = plainRun(block.content).trim();
      return quoted === '' || !summary.startsWith(quoted);
    }
    return true;
  });
}

/**
 * Clips `text` to `max` characters with a trailing ellipsis.
 *
 * @returns The clipped text.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1)}…`;
}

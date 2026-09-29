/** @module app/notifications/degrade — `degrade(message, capabilities)`: the one shared, pure step that adapts a `NotificationMessage` to what a renderer supports (D-32, spec 03 §9.2). Renderers never implement fallbacks themselves. */

import type {
  Block,
  Inline,
  NotificationAction,
  NotificationMessage,
  OpenAction,
} from '@browserhive/contracts/notifications';
import type { ChannelCapabilities } from '../../ports/notification-channel.ts';
import { bold, clip, code, formatCount, link, text } from './message.ts';

/** Label of the link that replaces cut content and actions a channel cannot show. */
export const OPEN_IN_BROWSERHIVE = 'Open in BrowserHive';
/** Path used when a message has no link of its own. */
const FALLBACK_PATH = '/notifications';

/** Characters of visible text in an inline run. */
function inlineLength(run: readonly Inline[]): number {
  let n = 0;
  for (const node of run) n += node.type === 'time' ? 16 : node.text.length;
  return n;
}

/** Characters of visible text in one block. */
function blockLength(block: Block): number {
  switch (block.type) {
    case 'text':
    case 'footer':
    case 'quote':
      return inlineLength(block.content);
    case 'heading':
    case 'code':
      return block.text.length;
    case 'fields':
      return block.items.reduce((n, i) => n + i.label.length + 2 + inlineLength(i.value), 0);
    case 'list':
      return block.items.reduce((n, i) => n + 2 + inlineLength(i), 0);
    case 'table':
      return (
        block.columns.reduce((n, c) => n + c.length, 0) +
        block.rows.reduce((n, r) => n + r.reduce((m, c) => m + inlineLength(c), 0), 0)
      );
    case 'image':
      return block.alt.length;
    case 'divider':
      return 0;
    case 'chart':
      return block.label.length + block.values.length + 16;
  }
}

/** Eighth-block characters, lowest first. */
const BARS = '▁▂▃▄▅▆▇█';

/**
 * Text bars for a series (`▁▂▅▇█▃`): each value scaled against the largest; all zero is all `▁`.
 *
 * @returns One character per value.
 */
export function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values);
  if (max <= 0) return BARS[0]?.repeat(values.length) ?? '';
  return values
    .map(
      (v) =>
        BARS[Math.min(BARS.length - 1, Math.round((Math.max(0, v) / max) * (BARS.length - 1)))],
    )
    .join('');
}

/** No-break space: "peak 1,525 calls" wraps as one piece on a narrow phone. */
const NBSP = '\u00a0';

/** A chart as one paragraph: its label, the bars in monospace and the peak. */
function chartToText(block: Extract<Block, { type: 'chart' }>): Block {
  const peak = Math.max(0, ...block.values);
  const unit = block.unit === null ? '' : `${NBSP}${block.unit}`;
  return {
    type: 'text',
    content: [
      bold(block.label),
      text(' '),
      code(sparkline(block.values)),
      text(` peak${NBSP}${formatCount(peak)}${unit}`),
    ],
  };
}

/** A table as a list: one item per row, `column: value` pairs joined with `·`. */
function tableToList(block: Extract<Block, { type: 'table' }>): Block[] {
  if (block.rows.length === 0) return [];
  const items = block.rows.map((row) => {
    const out: Inline[] = [];
    row.forEach((cell, i) => {
      if (i > 0) out.push(text(' · '));
      const column = block.columns[i];
      // The space stays outside the bold run: `**Tool:** x`, which every markdown renders.
      if (column !== undefined) out.push(bold(`${column}:`), text(' '));
      out.push(...cell);
    });
    return out;
  });
  return [{ type: 'list', ordered: false, items }];
}

/** Rich blocks as plain paragraphs, for renderers that only show text. */
function toPlain(block: Block): Block[] {
  switch (block.type) {
    case 'heading':
      return [{ type: 'text', content: [bold(block.text)] }];
    case 'fields':
      return block.items.map((i) => ({
        type: 'text',
        content: [bold(`${i.label}:`), text(' '), ...i.value],
      }));
    case 'quote':
      return [{ type: 'text', content: [text('“'), ...block.content, text('”')] }];
    case 'list':
      return block.items.map((item, n) => ({
        type: 'text',
        content: [text(block.ordered ? `${n + 1}. ` : '• '), ...item],
      }));
    case 'footer':
      return [{ type: 'text', content: block.content }];
    case 'code':
      return [{ type: 'text', content: [{ type: 'code', text: block.text }] }];
    case 'divider':
      return [];
    default:
      return [block];
  }
}

function adaptBlocks(blocks: readonly Block[], caps: ChannelCapabilities): Block[] {
  let out: Block[] = [];
  for (const block of blocks) {
    if (block.type === 'image' && !caps.images) {
      if (block.path !== null)
        out.push({ type: 'text', content: [link('View screenshot', block.path)] });
      continue;
    }
    if (block.type === 'table' && !caps.tables) {
      out.push(...tableToList(block));
      continue;
    }
    if (block.type === 'chart' && !caps.charts) {
      out.push(chartToText(block));
      continue;
    }
    out.push(block);
  }
  if (!caps.richBlocks) out = out.flatMap(toPlain);
  return out;
}

/** Act buttons become their open fallback where a channel cannot act; duplicates by path go. */
function adaptActions(
  message: NotificationMessage,
  caps: ChannelCapabilities,
): NotificationAction[] {
  const out: NotificationAction[] = [];
  const paths = new Set<string>();
  for (const action of message.actions) {
    if (action.kind === 'act') {
      if (message.state !== 'open') continue;
      if (caps.actButtons) {
        out.push(action);
        continue;
      }
      if (paths.has(action.fallback.path)) continue;
      paths.add(action.fallback.path);
      out.push({
        kind: 'open',
        id: action.id,
        label: action.fallback.label,
        style: action.style === 'danger' ? 'default' : action.style,
        path: action.fallback.path,
      });
      continue;
    }
    if (paths.has(action.path)) continue;
    paths.add(action.path);
    out.push(action);
  }
  return out.slice(0, Math.max(0, caps.maxButtons));
}

/** The path "Open in BrowserHive" should go to: the first open link, else the inbox. */
function primaryPath(message: NotificationMessage): string {
  const first = message.actions[0];
  if (first === undefined) return FALLBACK_PATH;
  return first.kind === 'open' ? first.path : first.fallback.path;
}

function openFooter(path: string, prefix = ''): Block {
  return {
    type: 'footer',
    content: [...(prefix === '' ? [] : [text(prefix)]), link(OPEN_IN_BROWSERHIVE, path)],
  };
}

/**
 * Adapts a message to a renderer's capabilities (D-32):
 * - images are dropped, or become a "View screenshot" link to their dashboard page;
 * - tables become lists, charts a line of text bars, and without rich blocks every block becomes
 *   plain paragraphs;
 * - act buttons become their `open` fallback where the channel cannot act, and never survive a
 *   state other than `open`; duplicate links go; at most `maxButtons` remain; without link buttons
 *   the first link becomes an "Open in BrowserHive" footer;
 * - the title is clipped to `maxTitleChars`, and when summary and blocks exceed `maxTextChars` the
 *   blocks are cut and a "… Open in BrowserHive" footer is added.
 *
 * @returns The degraded message; the input is not modified.
 */
export function degrade(
  message: NotificationMessage,
  caps: ChannelCapabilities,
): NotificationMessage {
  const path = primaryPath(message);
  let actions: NotificationAction[] = adaptActions(message, caps);
  let blocks = adaptBlocks(message.blocks, caps);
  if (!caps.openLinks && actions.length > 0) {
    const first = actions.find((a): a is OpenAction => a.kind === 'open');
    actions = actions.filter((a) => a.kind === 'act');
    if (first !== undefined) blocks = [...blocks, openFooter(first.path)];
  }
  const budget = Math.max(0, caps.maxTextChars);
  const summary = clip(message.summary, budget);
  let used = summary.length;
  const kept: Block[] = [];
  let cut = false;
  for (const block of blocks) {
    const n = blockLength(block);
    if (used + n <= budget) {
      kept.push(block);
      used += n;
      continue;
    }
    cut = true;
    break;
  }
  if (cut) {
    const footer = openFooter(path, '… ');
    if (used + blockLength(footer) > budget && kept.length > 0) kept.pop();
    kept.push(footer);
  }
  return {
    ...message,
    title: clip(message.title, Math.max(1, caps.maxTitleChars)),
    summary,
    blocks: kept,
    actions,
    privacy: {
      level: message.privacy.level,
      has_image: kept.some((b) => b.type === 'image'),
    },
  };
}

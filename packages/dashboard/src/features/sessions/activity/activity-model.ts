/** @module features/sessions/activity/activity-model — pure helpers for the Activity stream: fetch kinds, folding a page visit into the tool call that caused it and a `request_attention` call into its attention request, per-tool icons, row descriptions, error cross-cut, event time format */
import type { PageRow, TimelineItem, TimelineKind, ToolCallRow } from '@browserhive/contracts/http';
import { formatBytes } from '@/lib/format/bytes.ts';
import { formatMs } from '@/lib/format/time.ts';
import type { IconName } from '@/lib/icons.ts';
import type { Tone } from '@/lib/status-registry.ts';

/** Kind filter chips in display order. */
export const ACTIVITY_KINDS: readonly { readonly value: TimelineKind; readonly label: string }[] = [
  { value: 'tool', label: 'Tools' },
  { value: 'page', label: 'Pages' },
  { value: 'attention', label: 'Attention' },
  { value: 'vault', label: 'Vault' },
  { value: 'blocked', label: 'Blocked' },
];

/** Toggle one kind in a kinds list (empty → absent, which means every kind). */
export function toggleKind(
  kinds: readonly TimelineKind[] | undefined,
  kind: TimelineKind,
): TimelineKind[] | undefined {
  const current = kinds ?? [];
  const next = current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind];
  return next.length === 0 ? undefined : next;
}

/**
 * Kinds to request for a kinds filter. Page visits are fetched alongside tool calls so a navigate
 * (or a click that navigated) can show where it landed; they are folded into the call, not shown.
 */
export function fetchKinds(kinds: readonly TimelineKind[] | undefined): TimelineKind[] | undefined {
  if (kinds === undefined || kinds.length === 0) return undefined;
  const set = new Set(kinds);
  if (set.has('tool')) set.add('page');
  return [...set].sort();
}

/** One rendered activity row: a timeline item plus the page visit folded into a tool call. */
export interface ActivityEntry {
  readonly id: string;
  readonly item: TimelineItem;
  /** The page visit this tool call produced (same `event_id`). */
  readonly landed?: PageRow;
  /** Attention rows: the `request_attention` call that opened the request (shown as one event). */
  readonly call?: ToolCallRow;
}

/** How far apart a `request_attention` call and its request may be when no `event_id` links them. */
const ATTENTION_CALL_WINDOW_MS = 3000;

/** Pair each attention request with the `request_attention` call that opened it. */
function attentionCalls(items: readonly TimelineItem[]): Map<string, ToolCallRow> {
  const calls = items.flatMap((item) =>
    item.kind === 'tool' && item.row.tool === 'request_attention' ? [item.row] : [],
  );
  const byRequest = new Map<string, ToolCallRow>();
  if (calls.length === 0) return byRequest;
  const used = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'attention') continue;
    const row = item.row;
    const exact =
      row.event_id !== null ? calls.find((call) => call.event_id === row.event_id) : undefined;
    const near =
      exact ??
      calls
        .filter(
          (call) =>
            !used.has(call.event_id) &&
            Math.abs(call.ts - row.created_at) <= ATTENTION_CALL_WINDOW_MS,
        )
        .sort((a, b) => Math.abs(a.ts - row.created_at) - Math.abs(b.ts - row.created_at))[0];
    if (near === undefined) continue;
    used.add(near.event_id);
    byRequest.set(row.request_id, near);
  }
  return byRequest;
}

/**
 * Build the rows for the selected kinds (`undefined` = every kind). A page visit whose tool call
 * is loaded is folded into that call when tools are shown, so a navigation reads as one event.
 */
export function buildEntries(
  items: readonly TimelineItem[],
  kinds: readonly TimelineKind[] | undefined,
): readonly ActivityEntry[] {
  const shown = (kind: TimelineKind) => kinds === undefined || kinds.includes(kind);
  const toolIds = new Set<string>();
  const pagesByEvent = new Map<string, PageRow>();
  for (const item of items) {
    if (item.kind === 'tool') toolIds.add(item.row.event_id);
    if (item.kind === 'page' && !pagesByEvent.has(item.row.event_id)) {
      pagesByEvent.set(item.row.event_id, item.row);
    }
  }
  // A `request_attention` call and the request it opened read as one event on the attention row.
  const asks = shown('attention') ? attentionCalls(items) : new Map<string, ToolCallRow>();
  const folded = new Set([...asks.values()].map((call) => call.event_id));
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = itemId(item);
    if (seen.has(id) || !shown(item.kind)) continue;
    seen.add(id);
    if (item.kind === 'page' && shown('tool') && toolIds.has(item.row.event_id)) continue;
    if (item.kind === 'tool') {
      if (folded.has(item.row.event_id)) continue;
      const landed = shown('tool') ? pagesByEvent.get(item.row.event_id) : undefined;
      out.push(landed !== undefined ? { id, item, landed } : { id, item });
    } else if (item.kind === 'attention') {
      const call = asks.get(item.row.request_id);
      out.push(call !== undefined ? { id, item, call } : { id, item });
    } else {
      out.push({ id, item });
    }
  }
  return out;
}

/** The unique item id (REST `id`; the formula for rows built before ids existed). */
export function itemId(item: TimelineItem): string {
  if (typeof item.id === 'string' && item.id !== '') return item.id;
  return `${item.kind}:${item.kind === 'attention' ? item.row.request_id : item.row.event_id}`;
}

/** Failed tool calls (soft too), non-success vault fills, blocked requests, failed attention. */
export function isErrorItem(item: TimelineItem): boolean {
  switch (item.kind) {
    case 'tool':
      return !item.row.ok || item.row.error_code !== null;
    case 'vault':
      return item.row.result !== 'success';
    case 'blocked':
      return true;
    case 'attention':
      return (
        item.row.status === 'rejected' ||
        item.row.status === 'timeout' ||
        item.row.status === 'cancelled'
      );
    case 'page':
      return false;
    default:
      return false;
  }
}

/** What a row shows. `primary` is never repeated in `secondary`. */
export interface ActivityDescription {
  readonly icon: IconName;
  readonly tone: Tone;
  /** Short kind label for the table view and screen readers. */
  readonly kindLabel: string;
  readonly primary: string;
  /** Primary is code-like (tool names). */
  readonly primaryMono: boolean;
  /** Second line: a URL (rendered host + path) or plain text. */
  readonly secondary?:
    | { readonly type: 'url'; readonly url: string; readonly note?: string }
    | { readonly type: 'text'; readonly text: string; readonly tone?: Tone }
    | { readonly type: 'error'; readonly code: string | null; readonly message: string | null };
  /** Outcome shown next to the primary text (attention: waiting, resolved, rejected…). */
  readonly badge?: { readonly label: string; readonly tone: Tone };
  /**
   * Status for the table view. `label` is empty when there is nothing to say (a successful call,
   * a visited page): the column then stays blank instead of repeating "ok" on every row.
   */
  readonly status: { readonly label: string; readonly tone: Tone };
  readonly duration?: string;
  readonly size?: string;
  readonly hasScreenshot: boolean;
}

/** Icons for the tools an agent calls most; everything else keeps the generic wrench. */
const TOOL_ICONS: Readonly<Record<string, IconName>> = {
  navigate: 'toolNavigate',
  go_back: 'toolHistory',
  go_forward: 'arrowRight',
  reload: 'toolReload',
  click: 'toolClick',
  hover: 'toolHover',
  drag_and_drop: 'toolDrag',
  fill: 'toolType',
  type_text: 'toolType',
  press_key: 'toolKey',
  select_option: 'toolSelect',
  scroll: 'toolScroll',
  screenshot: 'toolScreenshot',
  snapshot: 'toolContent',
  get_content: 'toolContent',
  evaluate: 'toolEvaluate',
  get_cookies: 'toolCookies',
  set_cookies: 'toolCookies',
  upload_file: 'toolUpload',
  download_file: 'toolDownload',
  wait_for_selector: 'toolWait',
  wait_for_url: 'toolWait',
  wait_for_load_state: 'toolWait',
  new_tab: 'toolTab',
  switch_tab: 'toolTab',
  close_tab: 'toolTab',
  list_tabs: 'toolTab',
  launch_session: 'toolLaunch',
  close_session: 'toolClose',
  save_storage_state: 'toolSave',
  save_full_profile: 'toolSave',
  vault_fill: 'toolVault',
  vault_list_available: 'toolVault',
  request_attention: 'attention',
  get_attention_result: 'attention',
  set_viewport: 'toolViewport',
};

/** Icon for a tool name. */
export function toolIcon(tool: string): IconName {
  return TOOL_ICONS[tool] ?? 'tool';
}

/** Human status for an attention row. */
const ATTENTION_STATUS: Readonly<Record<string, { label: string; tone: Tone }>> = {
  pending: { label: 'waiting', tone: 'warn' },
  resolved: { label: 'resolved', tone: 'success' },
  rejected: { label: 'rejected', tone: 'danger' },
  timeout: { label: 'timed out', tone: 'danger' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
};

/** Describe an entry for the row renderers. */
export function describeEntry(entry: ActivityEntry): ActivityDescription {
  const { item } = entry;
  switch (item.kind) {
    case 'tool': {
      const row = item.row;
      const failed = !row.ok || row.error_code !== null;
      return {
        icon: toolIcon(row.tool),
        tone: failed ? 'danger' : 'neutral',
        kindLabel: 'Tool call',
        primary: row.tool,
        primaryMono: true,
        ...(failed && (row.error_code !== null || row.error_message !== null)
          ? {
              secondary: {
                type: 'error' as const,
                code: row.error_code,
                message: row.error_message,
              },
            }
          : entry.landed !== undefined
            ? {
                secondary: {
                  type: 'url' as const,
                  url: entry.landed.url,
                  ...(entry.landed.title !== null &&
                    entry.landed.title !== '' && { note: entry.landed.title }),
                },
              }
            : {}),
        status: failed
          ? { label: row.error_code ?? 'failed', tone: 'danger' }
          : { label: '', tone: 'success' },
        duration: formatMs(row.duration_ms),
        size: formatBytes(row.result_size_bytes),
        hasScreenshot: row.has_screenshot,
      };
    }
    case 'page': {
      const row = item.row;
      const title = row.title !== null && row.title.trim() !== '' ? row.title : null;
      return {
        icon: 'globe',
        tone: 'info',
        kindLabel: 'Page',
        primary: title ?? row.domain,
        primaryMono: false,
        secondary: { type: 'url', url: row.url },
        status: { label: '', tone: 'info' },
        hasScreenshot: false,
      };
    }
    case 'attention': {
      const row = item.row;
      const status = ATTENTION_STATUS[row.status] ?? { label: row.status, tone: 'neutral' };
      const replied = row.status !== 'pending' && row.message !== null && row.message !== '';
      return {
        icon: 'attention',
        tone: status.tone === 'danger' ? 'danger' : status.tone === 'success' ? 'success' : 'warn',
        kindLabel: 'Attention',
        primary: row.mode === 'takeover' ? 'Takeover requested' : 'Operator notified',
        primaryMono: false,
        badge: status,
        secondary: replied
          ? { type: 'text', text: `“${row.message}”` }
          : { type: 'text', text: row.reason },
        status,
        ...(row.waited_ms !== null && { duration: formatMs(row.waited_ms) }),
        hasScreenshot: false,
      };
    }
    case 'vault': {
      const row = item.row;
      const ok = row.result === 'success';
      return {
        icon: 'vault',
        tone: ok ? 'vault' : 'danger',
        kindLabel: 'Vault',
        primary: `Vault fill · ${row.entry_name}`,
        primaryMono: false,
        secondary: { type: 'url', url: row.page_url },
        status: ok
          ? { label: '', tone: 'success' }
          : { label: row.result.replaceAll('_', ' '), tone: 'danger' },
        hasScreenshot: false,
      };
    }
    case 'blocked': {
      const row = item.row;
      return {
        icon: 'blocklist',
        tone: 'danger',
        kindLabel: 'Blocked',
        primary: 'Request blocked',
        primaryMono: false,
        secondary: { type: 'url', url: row.url, note: row.pattern },
        status: { label: 'blocked', tone: 'danger' },
        hasScreenshot: false,
      };
    }
    default:
      return {
        icon: 'activity',
        tone: 'neutral',
        kindLabel: 'Event',
        primary: 'Event',
        primaryMono: false,
        status: { label: '', tone: 'neutral' },
        hasScreenshot: false,
      };
  }
}

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** `HH:MM:SS`, plus `Sep 15` when the event is not from today (local time). */
export function eventTime(
  ts: number,
  now: number,
): { readonly clock: string; readonly date?: string } {
  const at = new Date(ts);
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  return sameDay ? { clock: clock.format(at) } : { clock: clock.format(at), date: day.format(at) };
}

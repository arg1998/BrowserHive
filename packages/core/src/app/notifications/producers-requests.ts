/** @module app/notifications/producers-requests — producer rules of operator requests (spec 03 §9.1, D-16, D-32): attention requests and vault confirmations as they open, the revision that settles them, and the session helpers the other producers share. */

import type { NotificationState } from '@browserhive/contracts/enums';
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { parseSessionId } from '@browserhive/contracts/ids';
import {
  type Block,
  KIND_SEVERITY,
  type NotificationAction,
  type NotificationEntities,
} from '@browserhive/contracts/notifications';
import { sanitizeUrl } from '../../kernel/url.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { code, formatDuration, link, text, time } from './message.ts';
import type { NotificationDraft, ThreadRevision } from './producer-types.ts';

export function sessionLabel(sessionId: string): string {
  return parseSessionId(sessionId)?.slug ?? sessionId;
}

export function sessionEntities(sessionId: string | null): NotificationEntities {
  if (sessionId === null) return {};
  return { session_id: sessionId, session_slug: sessionLabel(sessionId) };
}

export function sessionField(sessionId: string) {
  return { label: 'Session', value: [link(sessionLabel(sessionId), `/sessions/${sessionId}`)] };
}

/** Hostname of a sanitized page URL, for routing (`entities.domain`). */
function domainOf(pageUrl: string | null): string | undefined {
  if (pageUrl === null) return undefined;
  try {
    const host = new URL(pageUrl).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Page, tool and wait fields shared by attention and vault confirm requests. */
function requestFields(d: OperatorRequestRow) {
  return [
    sessionField(d.session_id),
    ...(d.page_url === null ? [] : [{ label: 'Page', value: [code(sanitizeUrl(d.page_url))] }]),
    ...(d.tool === null ? [] : [{ label: 'Tool', value: [code(d.tool)] }]),
    { label: 'Waiting since', value: [time(d.created_at)] },
  ];
}

function requestEntities(d: OperatorRequestRow): NotificationEntities {
  const domain = domainOf(d.page_url);
  return {
    ...sessionEntities(d.session_id),
    owner: d.owner,
    request_id: d.request_id,
    ...(d.tool !== null && { tool: d.tool }),
    ...(domain !== undefined && { domain }),
  };
}

export function attentionCreated(payload: DomainEvents['attention.created']): NotificationDraft {
  const d = payload.request;
  const live = `/sessions/${d.session_id}?live=1`;
  const takeover = d.mode === 'takeover';
  const actions: NotificationAction[] = [
    takeover
      ? {
          kind: 'open',
          id: 'take-over',
          label: 'Take over',
          style: 'primary',
          path: `${live}&takeover=1`,
        }
      : { kind: 'open', id: 'open-live', label: 'Open live view', style: 'primary', path: live },
    {
      kind: 'act',
      id: 'resolve',
      label: 'Mark resolved',
      style: 'default',
      command: { op: 'attention.resolve', args: { request_id: d.request_id, decision: 'resolve' } },
      confirm: null,
      fallback: { label: 'Open in BrowserHive', path: live },
    },
    {
      kind: 'act',
      id: 'reject',
      label: 'Reject',
      style: 'danger',
      command: { op: 'attention.resolve', args: { request_id: d.request_id, decision: 'reject' } },
      confirm: 'Reject this request? The agent is told it was rejected.',
      fallback: { label: 'Open in BrowserHive', path: live },
    },
  ];
  const blocks: Block[] = [
    { type: 'quote', content: [text(d.reason)], collapsible: true },
    {
      type: 'fields',
      items: [{ label: 'Mode', value: [text(d.mode ?? 'notify')] }, ...requestFields(d)],
    },
  ];
  return {
    type: 'attention',
    kind: 'attention.requested',
    severity: KIND_SEVERITY['attention.requested'],
    state: 'open',
    thread: `attention:${d.request_id}`,
    title: 'Attention requested',
    body: `${d.reason}${d.mode ? ` · ${d.mode}` : ''} — agent blocked, lease frozen`,
    sessionId: d.session_id,
    target: `/sessions/${d.session_id}?live=1${takeover ? '&takeover=1' : ''}`,
    sourceEventId: d.request_id,
    dedupKey: `att:${d.request_id}`,
    content: () => ({ blocks, actions, entities: requestEntities(d) }),
    image: {
      sessionId: d.session_id,
      source: 'live',
      alt: 'The page when the agent asked for attention',
      path: live,
    },
  };
}

export function vaultConfirmCreated(
  payload: DomainEvents['vault.confirm.created'],
): NotificationDraft {
  const d = payload.request;
  const queue = '/vault?tab=confirm';
  const entry = d.entry_name ?? '';
  const actions: NotificationAction[] = [
    {
      kind: 'act',
      id: 'approve',
      label: 'Approve',
      style: 'primary',
      command: {
        op: 'vault.confirm.resolve',
        args: { request_id: d.request_id, decision: 'approve' },
      },
      confirm: null,
      fallback: { label: 'Review in BrowserHive', path: queue },
    },
    {
      kind: 'act',
      id: 'deny',
      label: 'Deny',
      style: 'danger',
      command: {
        op: 'vault.confirm.resolve',
        args: { request_id: d.request_id, decision: 'deny' },
      },
      confirm: 'Deny this vault fill?',
      fallback: { label: 'Review in BrowserHive', path: queue },
    },
    { kind: 'open', id: 'review', label: 'Review', style: 'default', path: queue },
  ];
  const blocks: Block[] = [
    {
      type: 'fields',
      items: [{ label: 'Entry', value: [code(entry)] }, ...requestFields(d)],
    },
  ];
  return {
    type: 'vault',
    kind: 'vault.confirm',
    severity: KIND_SEVERITY['vault.confirm'],
    state: 'open',
    thread: `vault:${d.request_id}`,
    title: 'Vault fill awaiting confirm',
    body: `entry ${entry} — approve or deny the release`,
    sessionId: d.session_id,
    // Send the operator to the vault page's confirm-release queue, where they approve/deny.
    target: queue,
    sourceEventId: d.request_id,
    dedupKey: `vault:${d.request_id}`,
    content: () => ({ blocks, actions, entities: requestEntities(d) }),
    // Captured when the confirmation is created: the fill waits for it, so this is before the
    // fill sequence starts (D-36); the capture refuses while a secret window is open.
    image: {
      sessionId: d.session_id,
      source: 'live',
      alt: 'The login page before the fill',
      path: `/sessions/${d.session_id}`,
    },
  };
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  telegram: 'Telegram',
  discord: 'Discord',
  ntfy: 'ntfy',
};

/**
 * How a settled request names who answered: "by admin" for a dashboard principal, "on Telegram by
 * 123456789" for an act button (`telegram:<id>`), "from ntfy" for the ntfy reply topic (D-41).
 *
 * @returns The phrase, without a leading space.
 */
export function actorPhrase(resolvedBy: string): string {
  const match = /^(telegram|discord|ntfy):(.+)$/.exec(resolvedBy);
  if (match === null) return `by ${resolvedBy}`;
  const platform = PLATFORM_NAMES[match[1] ?? ''] ?? match[1];
  if (match[1] === 'ntfy') return `from ${platform}`;
  return `on ${platform} by ${match[2]}`;
}

/** What the revision of a settled operator request is built from (a wire row or a stored record). */
export interface SettledRequestFacts {
  readonly requestId: string;
  readonly status: OperatorRequestRow['status'];
  readonly resolvedBy: string | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
  readonly waitedMs: number | null;
}

export function factsOf(d: OperatorRequestRow): SettledRequestFacts {
  return {
    requestId: d.request_id,
    status: d.status,
    resolvedBy: d.resolved_by,
    createdAt: d.created_at,
    resolvedAt: d.resolved_at,
    waitedMs: d.waited_ms,
  };
}

/**
 * Outcome of a settled operator request as a lifecycle change: resolved/approved and
 * rejected/denied → `resolved`, a timeout → `expired`, cancelled → `final`. Serves the live
 * `*.resolved` events and the startup catch-up of requests settled while nothing listened.
 *
 * @returns The revision of the request's thread, or `null` while it is pending.
 */
export function requestSettled(
  prefix: 'attention' | 'vault',
  f: SettledRequestFacts,
): ThreadRevision | null {
  if (f.status === 'pending') return null;
  const waited = f.waitedMs ?? (f.resolvedAt === null ? null : f.resolvedAt - f.createdAt);
  const after = waited === null ? '' : ` after ${formatDuration(waited)}`;
  // Orphan recovery and shutdown settle a request with no actor: the summary names none.
  const by = f.resolvedBy === null ? '' : ` ${actorPhrase(f.resolvedBy)}`;
  const vault = prefix === 'vault';
  const outcome: { state: NotificationState; label: string; summary: string } = (() => {
    switch (f.status) {
      case 'resolved':
        return {
          state: 'resolved',
          label: vault ? 'approved' : 'resolved',
          summary: `${vault ? 'Approved' : 'Resolved'}${by}${after}`,
        };
      case 'rejected':
        return {
          state: 'resolved',
          label: vault ? 'denied' : 'rejected',
          summary: `${vault ? 'Denied' : 'Rejected'}${by}${after}`,
        };
      case 'timeout':
        return { state: 'expired', label: 'timed out', summary: `Timed out${after}` };
      case 'cancelled':
        return {
          state: 'final',
          label: 'cancelled',
          summary: `Cancelled${after}: the agent stopped waiting`,
        };
    }
  })();
  return {
    thread: `${prefix}:${f.requestId}`,
    dedupKey: `${prefix}-res:${f.requestId}`,
    change: {
      state: outcome.state,
      summary: outcome.summary,
      fields: [
        { label: 'Outcome', value: [text(outcome.label)] },
        ...(f.resolvedAt === null ? [] : [{ label: 'Settled', value: [time(f.resolvedAt)] }]),
      ],
    },
  };
}

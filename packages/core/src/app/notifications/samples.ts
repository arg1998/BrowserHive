/** @module app/notifications/samples — realistic sample notifications built through the real producers, for the channel preview, the test send and the renderer goldens (spec 03 §4.8.1). Pure: fixed ids and times. */

import type { Block } from '@browserhive/contracts/notifications';
import { NotificationMessage, type PreviewSample } from '@browserhive/contracts/notifications';
import {
  AttentionCreatedEvent,
  AttentionResolvedEvent,
  SessionClosedEvent,
  SystemDegradedEvent,
  ToolCalledEvent,
  VaultConfirmCreatedEvent,
} from '@browserhive/contracts/ws';
import type { DomainEvents } from '../events/catalog.ts';
import { buildMessage, reviseMessage, time } from './message.ts';
import { draftFor, type ProducedEvent, revisionFor } from './producers.ts';

/** Session id of every sample. */
export const SAMPLE_SESSION_ID = 'checkout-a1b2c3d4';
/** Notification id of every sample. */
export const SAMPLE_NOTIFICATION_ID = 'n-sample000001';
/** Image ref of a sample screenshot (never resolves to bytes). */
export const SAMPLE_IMAGE_REF = 'nimg-sample';
/** Default time of the samples (2026-09-21, a fixed instant so goldens are stable). */
export const SAMPLE_NOW = 1_790_000_000_000;

const REQUEST_ID = 'a-sample000001';

/** Options of {@link sampleMessage}. */
export interface SampleOptions {
  /** Creation time of the sample; later revisions are a few seconds after. */
  readonly now?: number;
  /** Add a screenshot block (attention, vault confirm, crash); default none. */
  readonly image?: 'none' | 'masked' | 'unmasked';
}

function request(kind: 'attention' | 'vault_confirm', now: number, extra: object) {
  return {
    request_id: REQUEST_ID,
    kind,
    session_id: SAMPLE_SESSION_ID,
    session_slug: 'checkout',
    owner: 'local',
    reason: 'CAPTCHA on the checkout page: please solve it, then resume',
    mode: 'takeover',
    options: null,
    status: 'pending',
    message: null,
    resolved_by: null,
    resolution_reason: null,
    created_at: now,
    resolved_at: null,
    deadline_at: null,
    waited_ms: null,
    page_url: 'https://shop.example.com/checkout/payment?step=2',
    tool: 'click',
    event_id: null,
    entry_name: null,
    ...extra,
  };
}

function attentionEvent(now: number): ProducedEvent {
  const payload: DomainEvents['attention.created'] = AttentionCreatedEvent.parse({
    type: 'attention.created',
    request: request('attention', now, {}),
  });
  return { name: 'attention.created', at: now, payload };
}

function attentionResolvedEvent(now: number, at: number): ProducedEvent {
  const payload: DomainEvents['attention.resolved'] = AttentionResolvedEvent.parse({
    type: 'attention.resolved',
    request: request('attention', now, {
      status: 'resolved',
      resolved_by: 'admin',
      resolved_at: at,
      waited_ms: at - now,
    }),
  });
  return { name: 'attention.resolved', at, payload };
}

function vaultEvent(now: number): ProducedEvent {
  const payload: DomainEvents['vault.confirm.created'] = VaultConfirmCreatedEvent.parse({
    type: 'vault.confirm.created',
    request: request('vault_confirm', now, {
      mode: null,
      reason: 'vault_fill',
      entry_name: 'github',
      page_url: 'https://github.com/login',
      tool: 'vault_fill',
    }),
  });
  return { name: 'vault.confirm.created', at: now, payload };
}

function toolEvent(now: number): ProducedEvent {
  const base = ToolCalledEvent.parse({
    type: 'tool.called',
    has_detail: false,
    row: {
      event_id: 'e-00000000000000000000000003',
      session_id: SAMPLE_SESSION_ID,
      tool: 'navigate',
      tab_id: null,
      ok: false,
      error_code: 'NAVIGATION_TIMEOUT',
      error_message: null,
      duration_ms: 30_000,
      result_size_bytes: 0,
      ts: now,
      trace_id: null,
      has_screenshot: false,
    },
  });
  const payload: DomainEvents['tool.called'] = {
    ...base,
    observation: {
      eventId: base.row.event_id,
      sessionId: SAMPLE_SESSION_ID,
      connectionId: null,
      harness: 'claude-code',
      tool: 'navigate',
      tabId: null,
      args: {},
      ok: false,
      errorCode: 'NAVIGATION_TIMEOUT',
      errorMessage: null,
      resultText: null,
      resultSizeBytes: 0,
      durationMs: 30_000,
      ts: now,
      principal: 'local',
      traceId: null,
      spanId: null,
      seq: 3,
    },
  };
  return { name: 'tool.called', at: now, payload };
}

function crashEvent(now: number): ProducedEvent {
  const payload: DomainEvents['session.closed'] = SessionClosedEvent.parse({
    type: 'session.closed',
    session_id: SAMPLE_SESSION_ID,
    closed_at: now,
    reason: 'crash',
  });
  return { name: 'session.closed', at: now, payload };
}

function degradedEvent(now: number): ProducedEvent {
  const payload: DomainEvents['system.degraded'] = SystemDegradedEvent.parse({
    type: 'system.degraded',
    event: {
      event_id: 'e-00000000000000000000000009',
      code: 'RETENTION_FAILED',
      severity: 'error',
      message: 'The retention sweep failed: database is locked',
      details: null,
      first_seen_at: now,
      last_seen_at: now,
      count: 1,
      resolved_at: null,
    },
  });
  return { name: 'system.degraded', at: now, payload };
}

/** The first revision of a producer's draft for `event`, with `count` occurrences. */
function fromEvent(event: ProducedEvent, now: number, count = 1): NotificationMessage {
  const draft = draftFor(event);
  if (draft === null) throw new TypeError(`no draft for ${event.name}`);
  return buildMessage({
    id: SAMPLE_NOTIFICATION_ID,
    revision: count,
    thread: draft.thread,
    kind: draft.kind,
    severity: draft.severity,
    state: draft.state,
    alert: count === 1,
    createdAt: now,
    updatedAt: now + (count - 1) * 20_000,
    title: draft.group === undefined ? draft.title : draft.group.title(count),
    summary: draft.body ?? '',
    ...draft.content(count),
  });
}

/** Inserts a screenshot block after the first quote (or first) block. */
function withImage(
  message: NotificationMessage,
  masked: boolean,
  now: number,
  path: string,
): NotificationMessage {
  const image: Block = {
    type: 'image',
    ref: SAMPLE_IMAGE_REF,
    alt: `Screenshot of session ${SAMPLE_SESSION_ID.replace(/-[0-9a-z]{8}$/, '')}`,
    captured_at: now,
    masked,
    path,
  };
  const quote = message.blocks.findIndex((b) => b.type === 'quote');
  const at = quote >= 0 ? quote + 1 : 0;
  const blocks = [...message.blocks.slice(0, at), image, ...message.blocks.slice(at)];
  return { ...message, blocks, privacy: { ...message.privacy, has_image: true } };
}

function testMessage(now: number): NotificationMessage {
  return buildMessage({
    id: SAMPLE_NOTIFICATION_ID,
    revision: 1,
    thread: 'test:sample',
    kind: 'test',
    severity: 'info',
    state: 'final',
    alert: true,
    createdAt: now,
    updatedAt: now,
    title: 'BrowserHive test message',
    summary:
      'This channel works. Tap "Open dashboard" on your phone to check that links reach BrowserHive.',
    blocks: [
      {
        type: 'fields',
        items: [
          { label: 'Sent', value: [time(now)] },
          { label: 'Kind', value: [{ type: 'code', text: 'test' }] },
        ],
      },
    ],
    actions: [
      {
        kind: 'open',
        id: 'open-dashboard',
        label: 'Open dashboard',
        style: 'primary',
        path: '/notifications/channels',
      },
    ],
    entities: {},
  });
}

/**
 * A realistic notification of the given sample kind, built through the real producers so a
 * preview or a golden shows exactly what a real notification would carry.
 *
 * @returns The message (validated against the contract).
 */
export function sampleMessage(
  sample: PreviewSample,
  options: SampleOptions = {},
): NotificationMessage {
  const now = options.now ?? SAMPLE_NOW;
  const image = options.image ?? 'none';
  const live = `/sessions/${SAMPLE_SESSION_ID}?live=1`;
  let message: NotificationMessage;
  let imagePath: string | null = null;
  switch (sample) {
    case 'attention':
      message = fromEvent(attentionEvent(now), now);
      imagePath = live;
      break;
    case 'attention-resolved': {
      const first = fromEvent(attentionEvent(now), now);
      const at = now + 130_000;
      const revision = revisionFor(attentionResolvedEvent(now, at));
      if (revision === null) throw new TypeError('no revision for attention.resolved');
      message = reviseMessage(
        image === 'none' ? first : withImage(first, image === 'masked', now, live),
        revision.change,
        at,
      );
      return NotificationMessage.parse(message);
    }
    case 'vault-confirm':
      message = fromEvent(vaultEvent(now), now);
      imagePath = live;
      break;
    case 'tool-errors':
      message = fromEvent(toolEvent(now), now, 3);
      break;
    case 'crash':
      message = fromEvent(crashEvent(now), now);
      imagePath = `/sessions/${SAMPLE_SESSION_ID}`;
      break;
    case 'degraded':
      message = fromEvent(degradedEvent(now), now);
      break;
    case 'test':
      message = testMessage(now);
      break;
  }
  if (image !== 'none' && imagePath !== null) {
    message = withImage(message, image === 'masked', now, imagePath);
  }
  return NotificationMessage.parse(message);
}

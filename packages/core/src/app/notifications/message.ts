/** @module app/notifications/message — pure builders of the `NotificationMessage` contract (D-32, spec 03 §9.2): inline helpers, the first revision from a draft, lifecycle revisions, redaction of every string leaf and the stored-JSON codec. */

import type {
  NotificationKind,
  NotificationSeverity,
  NotificationState,
} from '@browserhive/contracts/enums';
import {
  type Block,
  type Inline,
  KIND_CATEGORY,
  NOTIFICATION_LABEL_MAX,
  NOTIFICATION_SCHEMA_VERSION,
  NOTIFICATION_SUMMARY_MAX,
  NOTIFICATION_TEXT_MAX,
  NOTIFICATION_TITLE_MAX,
  type NotificationAction,
  type NotificationEntities,
  NotificationMessage,
} from '@browserhive/contracts/notifications';
import type { Redactor } from '../../kernel/redact.ts';

/** Plain text inline. */
export function text(value: string): Inline {
  return { type: 'text', text: clip(value, NOTIFICATION_TEXT_MAX) };
}

/** Bold inline. */
export function bold(value: string): Inline {
  return { type: 'bold', text: clip(value, NOTIFICATION_TEXT_MAX) };
}

/** Monospace inline. */
export function code(value: string): Inline {
  return { type: 'code', text: clip(value, NOTIFICATION_TEXT_MAX) };
}

/** Dashboard link inline. */
export function link(label: string, path: string): Inline {
  return { type: 'link', text: clip(label, NOTIFICATION_TEXT_MAX), path };
}

/** Localisable time inline. */
export function time(at: number, style: 'relative' | 'absolute' = 'absolute'): Inline {
  return { type: 'time', at, style };
}

/**
 * Shortens `value` to at most `max` characters, ending in `…` when cut.
 *
 * @returns The clipped string.
 */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return max <= 1 ? value.slice(0, max) : `${value.slice(0, max - 1)}…`;
}

/**
 * Human duration for summaries: `850 ms`, `42 s`, `2m 10s`, `3h 05m`.
 *
 * @returns The formatted duration.
 */
export function formatDuration(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  if (v < 1000) return `${v} ms`;
  const s = Math.round(v / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const PERCENT_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

/**
 * A count with thousands separators, like the dashboard (`3,412`; at most one decimal).
 *
 * @returns The formatted number.
 */
export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

/**
 * A ratio (0–1) as a percentage with at most one decimal (`2.1%`).
 *
 * @returns The formatted percentage.
 */
export function formatPercent(ratio: number): string {
  return PERCENT_FORMAT.format(ratio);
}

/** Everything the first revision of a message is built from (the producer's facts). */
export interface MessageContent {
  readonly blocks: readonly Block[];
  readonly actions: readonly NotificationAction[];
  readonly entities: NotificationEntities;
}

/** Inputs of {@link buildMessage}. */
export interface BuildMessageInput extends MessageContent {
  readonly id: string;
  readonly revision: number;
  readonly thread: string;
  readonly kind: NotificationKind;
  readonly severity: NotificationSeverity;
  readonly state: NotificationState;
  readonly alert: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly title: string;
  readonly summary: string;
}

/**
 * Builds one full-state revision. Title and summary are clipped to the contract's limits; act
 * buttons exist only while the state is `open` (a one-shot `final` fact keeps its links, spec 03 §9.2).
 *
 * @returns The message (not yet redacted; see {@link scrubMessage}).
 */
export function buildMessage(input: BuildMessageInput): NotificationMessage {
  return {
    schema: NOTIFICATION_SCHEMA_VERSION,
    id: input.id,
    revision: input.revision,
    thread: input.thread,
    kind: input.kind,
    category: KIND_CATEGORY[input.kind],
    severity: input.severity,
    state: input.state,
    alert: input.alert,
    at: { created: input.createdAt, updated: Math.max(input.updatedAt, input.createdAt) },
    title: clip(input.title, NOTIFICATION_TITLE_MAX),
    summary: clip(input.summary, NOTIFICATION_SUMMARY_MAX),
    blocks: [...input.blocks],
    actions:
      input.state === 'open' ? [...input.actions] : input.actions.filter((a) => a.kind === 'open'),
    entities: input.entities,
    privacy: { level: 'full', has_image: input.blocks.some((b) => b.type === 'image') },
  };
}

/** A lifecycle change applied to the previous revision. */
export interface LifecycleChange {
  readonly state: NotificationState;
  /** New summary (the outcome sentence); `undefined` keeps the previous one. */
  readonly summary?: string;
  /** Severity after the change; `undefined` keeps it. */
  readonly severity?: NotificationSeverity;
  /** Fields appended to the first `fields` block (or added as a new one), e.g. the outcome. */
  readonly fields?: readonly { readonly label: string; readonly value: readonly Inline[] }[];
}

/**
 * Derives the next revision from the previous full state: `revision + 1`, silent (`alert: false`),
 * the new state and outcome, and no actions once the state has left `open` (the buttons disappear
 * with the silent edit).
 *
 * @returns The next revision.
 */
export function reviseMessage(
  prev: NotificationMessage,
  change: LifecycleChange,
  at: number,
): NotificationMessage {
  let blocks: Block[] = [...prev.blocks];
  if (change.fields !== undefined && change.fields.length > 0) {
    const index = blocks.findIndex((b) => b.type === 'fields');
    const extra = change.fields.map((f) => ({ label: f.label, value: [...f.value] }));
    const existing = blocks[index];
    if (existing !== undefined && existing.type === 'fields') {
      const items = [
        ...existing.items.filter((i) => !extra.some((e) => e.label === i.label)),
        ...extra,
      ].slice(0, 12);
      blocks = blocks.map((b, i) => (i === index ? { type: 'fields', items } : b));
    } else {
      blocks = [{ type: 'fields', items: extra.slice(0, 12) }, ...blocks];
    }
  }
  return {
    ...prev,
    revision: prev.revision + 1,
    state: change.state,
    severity: change.severity ?? prev.severity,
    alert: false,
    at: { created: prev.at.created, updated: Math.max(at, prev.at.updated) },
    summary:
      change.summary === undefined ? prev.summary : clip(change.summary, NOTIFICATION_SUMMARY_MAX),
    blocks,
    actions: change.state === 'open' ? prev.actions : [],
  };
}

/**
 * Redacts every string leaf of a message with the `Redactor` (registered secrets and credential
 * patterns, spec 10 §9), then re-clips title and summary so a replacement cannot break the limits.
 * Structural fields (schema, ids, enums) contain no free text and pass unchanged.
 *
 * @returns The redacted message.
 */
export function scrubMessage(
  message: NotificationMessage,
  redactor: Redactor,
): NotificationMessage {
  const walk = (value: unknown, key: string): unknown => {
    if (typeof value === 'string') {
      const max = LIMIT_BY_KEY[key] ?? NOTIFICATION_TEXT_MAX;
      return clip(redactor.scrubText(value), max);
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = PASS_THROUGH.has(k) ? v : walk(v, k);
      return out;
    }
    return value;
  };
  return NotificationMessage.parse(walk(message, ''));
}

/** Length limits by key, so a replacement longer than the secret never breaks the contract. */
const LIMIT_BY_KEY: Readonly<Record<string, number>> = {
  title: NOTIFICATION_TITLE_MAX,
  summary: NOTIFICATION_SUMMARY_MAX,
  confirm: NOTIFICATION_SUMMARY_MAX,
  label: NOTIFICATION_LABEL_MAX,
  columns: NOTIFICATION_LABEL_MAX,
  thread: 160,
  path: 2048,
  ref: 512,
  language: 32,
  session_id: 128,
  session_slug: 64,
  harness: 64,
  owner: 128,
  tool: 64,
  error_code: 64,
  domain: 253,
  request_id: 64,
  decision: 256,
  unit: 24,
  time_zone: 64,
};

/** Keys whose values are identifiers or enums, never free text. */
const PASS_THROUGH: ReadonlySet<string> = new Set([
  'schema',
  'id',
  'kind',
  'category',
  'severity',
  'state',
  'type',
  'style',
  'op',
]);

/** Serialises a message for `notifications.message_json`. */
export function encodeMessage(message: NotificationMessage): string {
  return JSON.stringify(message);
}

/**
 * Parses a stored message. A row from before schema v5 (`null`) or an unreadable value yields
 * `null`: nothing is ever fabricated for it.
 *
 * @returns The message, or `null`.
 */
export function decodeMessage(json: string | null): NotificationMessage | null {
  if (json === null) return null;
  try {
    const parsed = NotificationMessage.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

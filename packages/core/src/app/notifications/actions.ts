/** @module app/notifications/actions — act buttons (spec 03 §9.6, D-41): mints single-use command tokens for the outbox, checks and runs a press through the same services as the dashboard, audits it, and lists the audit. */

import type { ActionRow } from '@browserhive/contracts/http';
import {
  ACTION_OUTCOME_TEXT,
  ACTION_TOKEN_LENGTH,
  ACTION_TOKEN_PREFIX,
  ACTION_TOKEN_TTL_MS,
  hasPresserIdentity,
  type NotificationMessage,
} from '@browserhive/contracts/notifications';
import { SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import { sha256Hex } from '../../domain/auth/digest.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Redactor } from '../../kernel/redact.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { PressAnswer, PressEvent } from '../../ports/notification-channel.ts';
import type { NotificationActionOutcome } from '../../ports/persistence/enums.ts';
import type {
  NotificationActionRecord,
  NotificationActionTokenRecord,
  NotificationChannelRecord,
} from '../../ports/persistence/records.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { ChannelRegistry } from './channel-registry.ts';
import { clip, decodeMessage } from './message.ts';

/** Longest detail stored on an audit row. */
const DETAIL_MAX = 500;

/** Runs one command op for a press. Returns the short success text ("Resolved"). */
export interface ActionExecutor {
  /** The scope of the dashboard route this op mirrors (recorded on the span). */
  readonly scope: string;
  run(args: Readonly<Record<string, string | number | boolean>>, actor: string): Promise<string>;
}

/** Counter of presses (spec 10 §7). */
export interface ActionCounter {
  add(value: number, attributes: { readonly channel_kind: string; readonly outcome: string }): void;
}

/** Dependencies of {@link NotificationActionService}. */
export interface NotificationActionServiceDeps {
  readonly repos: Pick<
    Repositories,
    'notifications' | 'notificationActionTokens' | 'notificationActions'
  >;
  readonly registry: ChannelRegistry;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** The command ops a press may run, by `NotificationCommandOp`. */
  readonly executors: ReadonlyMap<string, ActionExecutor>;
  /** Receives `action.recorded` (the live Actions view). */
  readonly bus?: EventPublisher<DomainEvents>;
  readonly redactor?: Redactor;
  readonly counter?: ActionCounter;
  readonly tracer?: Tracer;
}

/** A page of the press audit. */
export interface ActionPage {
  readonly items: readonly ActionRow[];
  readonly nextCursor: string | null;
}

/** Filters of the press audit. */
export interface ActionListInput {
  readonly cursor?: string;
  readonly limit: number;
  readonly channelId?: string;
  readonly notificationId?: string;
  readonly outcomes?: readonly NotificationActionOutcome[];
}

/** The actor a press is recorded as (`telegram:<id>`, `discord:<id>`, `ntfy:topic-b`). */
export function actorOf(actor: PressEvent['actor']): string {
  if (actor.platform === 'ntfy' || actor.id === null) return `${actor.platform}:topic-b`;
  return `${actor.platform}:${actor.id}`;
}

/** The answer text of each refusal (the presser reads it in the chat). */
function refusalText(
  outcome: Exclude<NotificationActionOutcome, 'done'>,
  press: PressEvent,
): string {
  switch (outcome) {
    case 'not_allowed':
      return press.actor.id === null
        ? 'You are not allowed to answer here.'
        : `Not allowed: your ${press.actor.platform === 'telegram' ? 'Telegram' : 'Discord'} id ${press.actor.id} is not on this channel's allow-list.`;
    case 'used':
      return 'This button was already used.';
    case 'expired':
      return 'This button has expired.';
    case 'stale':
      return 'This request is no longer waiting.';
    case 'wrong_channel':
      return 'This button belongs to another chat.';
    case 'disabled':
      return 'Answering from the chat is switched off for this channel.';
    case 'failed':
      return 'That did not work; open BrowserHive to answer.';
  }
}

function encodeCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ seq })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const seq =
      typeof parsed === 'object' && parsed !== null ? (parsed as { seq?: unknown }).seq : null;
    if (typeof seq === 'number' && Number.isInteger(seq) && seq > 0) return seq;
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_FAILED', {
    issues: [{ path: 'cursor', message: 'not an action cursor', code: 'custom' }],
  });
}

/** Where a channel's presses must come from: its Telegram chat or Discord channel (`null`: anywhere). */
export function pressOrigin(record: NotificationChannelRecord): string | null {
  if (record.kind === 'telegram') return record.target['chat_id'] ?? null;
  if (record.kind === 'discord') return record.target['channel_id'] ?? null;
  return null;
}

/**
 * Act buttons (D-41): the outbox mints tokens through {@link mint}; the press listeners hand every
 * press to {@link press}, which never throws.
 */
export class NotificationActionService {
  private readonly log: Logger;
  private readonly tracer: Tracer;

  constructor(private readonly deps: NotificationActionServiceDeps) {
    this.log = deps.logger.child({ module: 'notifications' });
    this.tracer = deps.tracer ?? trace.getTracer('browserhive');
  }

  /**
   * Mints one fresh token per act action of `message` for `channelId` and stores their hashes
   * before the platform call (an early press then finds its row).
   *
   * @returns Action id → button payload (`bh1:<token>`).
   */
  async mint(
    channelId: string,
    message: NotificationMessage,
    now: number,
  ): Promise<ReadonlyMap<string, string>> {
    const payloads = new Map<string, string>();
    const rows: NotificationActionTokenRecord[] = [];
    for (const action of message.actions) {
      if (action.kind !== 'act') continue;
      const token = this.deps.ids.opaque(ACTION_TOKEN_LENGTH);
      payloads.set(action.id, `${ACTION_TOKEN_PREFIX}${token}`);
      rows.push({
        tokenHash: sha256Hex(token),
        channelId,
        notificationId: message.id,
        actionId: action.id,
        op: action.command.op,
        args: action.command.args,
        createdAt: now,
        expiresAt: now + ACTION_TOKEN_TTL_MS,
        usedAt: null,
      });
    }
    if (rows.length > 0) await this.deps.repos.notificationActionTokens.insert(rows);
    return payloads;
  }

  /**
   * Checks and runs one press (spec 03 §9.6). Never throws: a failure becomes a `failed` answer.
   *
   * @returns What to tell the presser.
   */
  async press(press: PressEvent): Promise<PressAnswer> {
    try {
      return await this.handle(press);
    } catch (err) {
      this.log.error('press failed', { err: serializeError(err) });
      return { outcome: 'failed', text: refusalText('failed', press), refused: true };
    }
  }

  private async handle(press: PressEvent): Promise<PressAnswer> {
    const now = this.deps.clock.now();
    const hash = sha256Hex(press.token);
    const token = await this.deps.repos.notificationActionTokens.get(hash);
    if (token === null) {
      this.deps.counter?.add(1, { channel_kind: press.actor.platform, outcome: 'unknown' });
      this.log.warn('unknown button pressed', {
        platform: press.actor.platform,
        token: `${press.token.slice(0, 4)}…`,
      });
      return { outcome: 'unknown', text: 'This button is no longer valid.', refused: true };
    }
    const entry = this.deps.registry.get(token.channelId);
    const channel = entry?.record ?? null;
    const notification = await this.deps.repos.notifications.get(token.notificationId);
    const message = notification === null ? null : decodeMessage(notification.messageJson);
    const label =
      message?.actions.find((a) => a.id === token.actionId)?.label ?? notification?.title ?? null;
    const refuse = async (
      outcome: Exclude<NotificationActionOutcome, 'done' | 'failed'>,
    ): Promise<PressAnswer> => {
      const text = refusalText(outcome, press);
      await this.audit(press, token, channel, label, outcome, text, now);
      return { outcome, text, refused: true };
    };
    if (channel === null) return refuse('disabled');
    const origin = pressOrigin(channel);
    const platformMatches = channel.kind === press.actor.platform;
    if (!platformMatches || (origin !== null && press.origin !== null && press.origin !== origin)) {
      return refuse('wrong_channel');
    }
    if (channel.rules.act_buttons !== true || channel.status !== 'active')
      return refuse('disabled');
    if (token.usedAt !== null) return refuse('used');
    if (token.expiresAt <= now) return refuse('expired');
    if (notification === null || notification.state !== 'open') return refuse('stale');
    if (hasPresserIdentity(channel.kind)) {
      const allowed = channel.rules.allow_list ?? [];
      if (press.actor.id === null || !allowed.includes(press.actor.id))
        return refuse('not_allowed');
    }
    if (!(await this.deps.repos.notificationActionTokens.claim(hash, now))) return refuse('used');
    return this.run(press, token, channel, label, now);
  }

  private run(
    press: PressEvent,
    token: NotificationActionTokenRecord,
    channel: NotificationChannelRecord,
    label: string | null,
    now: number,
  ): Promise<PressAnswer> {
    const executor = this.deps.executors.get(token.op);
    return this.tracer.startActiveSpan(
      'notification.act',
      {
        attributes: {
          'browserhive.channel_kind': channel.kind,
          'browserhive.channel_id': channel.channelId,
          'browserhive.notification_id': token.notificationId,
          'browserhive.op': token.op,
        },
      },
      async (span) => {
        let outcome: NotificationActionOutcome;
        let text: string;
        try {
          if (executor === undefined) {
            outcome = 'failed';
            text = 'This action cannot be answered from a chat; open BrowserHive.';
          } else {
            span.setAttribute('browserhive.scope', executor.scope);
            text = await executor.run(token.args, actorOf(press.actor));
            outcome = 'done';
          }
        } catch (err) {
          if (
            isAppError(err) &&
            (err.code === 'ATTENTION_NOT_OPEN' ||
              err.code === 'CONFIRM_NOT_OPEN' ||
              err.code === 'NOT_FOUND')
          ) {
            outcome = 'stale';
            text = refusalText('stale', press);
          } else {
            outcome = 'failed';
            const detail = serializeError(err).message;
            text = `${refusalText('failed', press)} (${clip(this.scrub(detail), 120)})`;
            this.log.warn('press command failed', { op: token.op, err: serializeError(err) });
          }
        }
        span.setAttribute('browserhive.outcome', outcome);
        if (outcome === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
        span.end();
        await this.audit(press, token, channel, label, outcome, text, now);
        if (outcome === 'done') {
          this.log.info('act button pressed', { channel: channel.name, op: token.op });
        }
        return { outcome, text, refused: outcome !== 'done' };
      },
    );
  }

  private scrub(text: string): string {
    return this.deps.redactor?.scrubText(text) ?? text;
  }

  private async audit(
    press: PressEvent,
    token: NotificationActionTokenRecord,
    channel: NotificationChannelRecord | null,
    label: string | null,
    outcome: NotificationActionOutcome,
    detail: string,
    at: number,
  ): Promise<void> {
    const channelKind = channel?.kind ?? press.actor.platform;
    this.deps.counter?.add(1, { channel_kind: channelKind, outcome });
    const record = await this.deps.repos.notificationActions.insert({
      at,
      channelId: token.channelId,
      channelName: channel?.name ?? token.channelId,
      channelKind,
      notificationId: token.notificationId,
      actionId: token.actionId,
      actionLabel: label === null ? null : clip(label, 80),
      op: token.op,
      args: token.args,
      actor: actorOf(press.actor),
      actorName: press.actor.name === null ? null : clip(this.scrub(press.actor.name), 128),
      outcome,
      detail: clip(this.scrub(detail), DETAIL_MAX),
    });
    const row = await this.row(record, new Map());
    this.deps.bus?.publish('action.recorded', { type: 'action.recorded', action: row });
  }

  /** A page of the press audit, newest first. */
  async list(input: ActionListInput): Promise<ActionPage> {
    const beforeSeq = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const rows = await this.deps.repos.notificationActions.list({
      ...(input.channelId !== undefined && { channelId: input.channelId }),
      ...(input.notificationId !== undefined && { notificationId: input.notificationId }),
      ...(input.outcomes !== undefined && { outcomes: input.outcomes }),
      ...(beforeSeq !== undefined && { beforeSeq }),
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const titles = new Map<string, string | null>();
    const items: ActionRow[] = [];
    for (const r of page) items.push(await this.row(r, titles));
    const lastRow = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > input.limit && lastRow !== undefined ? encodeCursor(lastRow.seq) : null,
    };
  }

  private async row(
    r: NotificationActionRecord,
    titles: Map<string, string | null>,
  ): Promise<ActionRow> {
    let title: string | null = null;
    if (r.notificationId !== null) {
      const cached = titles.get(r.notificationId);
      if (cached !== undefined) title = cached;
      else {
        title = (await this.deps.repos.notifications.get(r.notificationId))?.title ?? null;
        titles.set(r.notificationId, title);
      }
    }
    return {
      seq: r.seq,
      at: r.at,
      channel_id: r.channelId,
      channel_name: this.deps.registry.get(r.channelId)?.record.name ?? r.channelName,
      channel_kind: r.channelKind,
      notification_id: r.notificationId,
      notification_title: title,
      action_id: r.actionId,
      action_label: r.actionLabel,
      op: r.op,
      actor: r.actor,
      actor_name: r.actorName,
      outcome: r.outcome,
      detail: r.detail ?? ACTION_OUTCOME_TEXT[r.outcome] ?? null,
    };
  }
}

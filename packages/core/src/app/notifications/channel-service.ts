/** @module app/notifications/channel-service — the notification channels API (spec 03 §4.8.1, D-33, D-35, D-38, D-39): views that never carry a secret value, CRUD of dashboard channels (startup channels read-only), pause/resume, the test send, the pure preview, the delivery log, the environment check, the Telegram connect flow, and the `channels` feed. */

import type { NotificationCategory } from '@browserhive/contracts/enums';
import {
  type ChannelCapabilitiesDto,
  type ChannelInput,
  type ChannelPatch,
  type ChannelPreview,
  type ChannelPreviewRequest,
  type ChannelTestResponse,
  type ChannelView,
  type DeliveryRow,
  DeliveryRow as DeliveryRowSchema,
  type PlatformRequest,
  type TelegramConnectResponse,
  type TelegramConnectStatus,
} from '@browserhive/contracts/http';
import {
  AvailableChannelKind,
  CHANNEL_KIND_SPECS,
  checkChannelConfig,
  type NotificationChannelRules,
  type NotificationMessage,
  NTFY_DEFAULT_SERVER,
  type PreviewSample,
  TELEGRAM_TTL_MAX_MS,
} from '@browserhive/contracts/notifications';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Redactor } from '../../kernel/redact.ts';
import { isLoopbackHost, isPrivateNetworkHost } from '../../kernel/url.ts';
import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import {
  type ChannelCapabilities,
  type ChannelDelivery,
  type ChannelRenderer,
  ChannelSendError,
  type LinkBuilder,
  type TelegramSetup,
  type TelegramStart,
} from '../../ports/notification-channel.ts';
import type {
  ChannelDeliveryStats,
  NotificationChannelRecord,
  NotificationDeliveryRecord,
  NotificationRecord,
} from '../../ports/persistence/records.ts';
import type { Repositories, UnitOfWork } from '../../ports/persistence/unit-of-work.ts';
import type { DomainEvents } from '../events/catalog.ts';
import type { ChannelRegistry, RegisteredChannel } from './channel-registry.ts';
import { restrictContent } from './content-level.ts';
import { degrade } from './degrade.ts';
import { applyImageRule, wantsImages } from './images.ts';
import { clip, decodeMessage, encodeMessage } from './message.ts';
import { contentLevelOf, deleteWhenResolved, expiryFor } from './routing.ts';
import { sampleMessage } from './samples.ts';

/** Window of the per-channel counts on the cards. */
const STATS_WINDOW_MS = 24 * 60 * 60_000;
/** How long the Telegram connect flow waits for `/start <code>`. */
export const TELEGRAM_CONNECT_MS = 2 * 60_000;
/** Connect sessions are forgotten this long after they end. */
const CONNECT_KEEP_MS = 10 * 60_000;
/** Debounce of `channel.changed` after deliveries moved. */
const CHANNEL_FEED_DEBOUNCE_MS = 750;
/** Rows re-published per notification after a delivery change. */
const FEED_ROWS = 20;
/** Longest `last_error` stored. */
const ERROR_MAX = 500;

/** Dependencies of {@link ChannelService}. */
export interface ChannelServiceDeps {
  readonly repos: Pick<
    Repositories,
    | 'notificationChannels'
    | 'notificationDeliveries'
    | 'notificationChannelMessages'
    | 'notifications'
  >;
  readonly uow: UnitOfWork;
  readonly registry: ChannelRegistry;
  /** The pure renderers per kind (the same the adapters use). */
  readonly renderers: ReadonlyMap<string, ChannelRenderer>;
  readonly links: LinkBuilder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly bus: EventPublisher<DomainEvents>;
  /** Reads the server's environment (whether a named variable is set; never exposed). */
  readonly env: (name: string) => string | undefined;
  /** Registers a secret value with the redactor before it is used. */
  readonly registerSecret?: (value: string) => void;
  readonly telegram?: TelegramSetup;
  readonly redactor?: Redactor;
  /** Timer for debounced feed events (defaults to `setTimeout`). */
  readonly schedule?: (fn: () => void, ms: number) => void;
}

/** A page of the delivery log. */
export interface DeliveryPage {
  readonly items: readonly DeliveryRow[];
  readonly nextCursor: string | null;
}

/** Filters of the delivery log. */
export interface DeliveryListInput {
  readonly cursor?: string;
  readonly limit: number;
  readonly channelId?: string;
  readonly notificationId?: string;
  readonly statuses?: readonly NotificationDeliveryRecord['status'][];
  readonly ops?: readonly NotificationDeliveryRecord['op'][];
  readonly kinds?: readonly string[];
}

interface ConnectSession {
  readonly id: string;
  readonly tokenEnv: string;
  readonly botUsername: string;
  readonly expiresAt: number;
  readonly abort: AbortController;
  status: TelegramConnectStatus['status'];
  start: TelegramStart | null;
  error: string | null;
  endedAt: number | null;
}

/** Capabilities in wire form. */
export function capabilitiesDto(c: ChannelCapabilities): ChannelCapabilitiesDto {
  return {
    rich_blocks: c.richBlocks,
    tables: c.tables,
    images: c.images,
    act_buttons: c.actButtons,
    open_links: c.openLinks,
    edit: c.edit,
    delete: c.delete,
    replies: c.replies,
    delete_window_ms: c.deleteWindowMs,
    max_title_chars: c.maxTitleChars,
    max_text_chars: c.maxTextChars,
    max_buttons: c.maxButtons,
  };
}

function last(value: string, n: number): string {
  return value.length <= n ? value : `…${value.slice(-n)}`;
}

function hostPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * A short, lossy rendering of where a channel sends (never a secret: variables are named).
 *
 * @returns The hint.
 */
export function targetHint(
  record: Pick<NotificationChannelRecord, 'kind' | 'mode' | 'target' | 'secretRefs'>,
): string {
  const t = record.target;
  const s = record.secretRefs;
  switch (record.kind) {
    case 'telegram': {
      const chat = t['chat_id'] ?? '';
      const base =
        t['chat_title'] !== undefined
          ? `${t['chat_title']} (${last(chat, 4)})`
          : `chat ${last(chat, 4)}`;
      return t['thread_id'] === undefined ? base : `${base} · topic ${t['thread_id']}`;
    }
    case 'discord':
      return `${record.mode ?? 'webhook'} from $${s['webhook'] ?? '?'}`;
    case 'ntfy': {
      const server = hostPath(t['server'] ?? NTFY_DEFAULT_SERVER);
      const topic = t['topic'] ?? (s['topic'] === undefined ? '?' : `$${s['topic']}`);
      return `${server}/${topic}`;
    }
    case 'webhook':
      return t['url'] !== undefined ? hostPath(t['url']) : `$${s['url'] ?? '?'}`;
    default:
      return record.kind;
  }
}

function webhookWarning(record: NotificationChannelRecord): string | null {
  if (record.kind !== 'webhook') return null;
  const url = record.target['url'];
  if (url === undefined) return null;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isLoopbackHost(host) || isPrivateNetworkHost(host)) {
      return `The webhook targets a private address (${host}): BrowserHive makes this request from inside your network.`;
    }
  } catch {
    return null;
  }
  return null;
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
    issues: [{ path: 'cursor', message: 'not a delivery cursor', code: 'custom' }],
  });
}

/**
 * The notification channels API (spec 03 §4.8.1). Every write goes to `notification_channels`
 * and then reloads the registry (the planner and the outbox read only its cache).
 */
export class ChannelService {
  private readonly log: Logger;
  private readonly connects = new Map<string, ConnectSession>();
  private readonly pendingChannels = new Set<string>();
  private channelTimer = false;

  constructor(private readonly deps: ChannelServiceDeps) {
    this.log = deps.logger.child({ module: 'notifications' });
  }

  // ---------------------------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------------------------

  /** Every channel (dashboard and startup), by name. */
  async list(): Promise<readonly ChannelView[]> {
    const stats = await this.stats();
    return this.deps.registry.channels().map((entry) => this.view(entry, stats));
  }

  /**
   * One channel.
   *
   * @throws AppError `CHANNEL_NOT_FOUND`.
   */
  async get(channelId: string): Promise<ChannelView> {
    const entry = this.entry(channelId);
    return this.view(entry, await this.stats());
  }

  private async stats(): Promise<ReadonlyMap<string, ChannelDeliveryStats>> {
    const rows = await this.deps.repos.notificationDeliveries.stats(
      this.deps.clock.now() - STATS_WINDOW_MS,
    );
    return new Map(rows.map((r) => [r.channelId, r]));
  }

  private entry(channelId: string): RegisteredChannel {
    const entry = this.deps.registry.get(channelId);
    if (entry === undefined) throw new AppError('CHANNEL_NOT_FOUND', { channel_id: channelId });
    return entry;
  }

  private isSet(name: string): boolean {
    const value = this.deps.env(name);
    return value !== undefined && value !== '';
  }

  private missingOf(record: NotificationChannelRecord): string[] {
    return Object.values(record.secretRefs).filter((name) => !this.isSet(name));
  }

  private view(
    entry: RegisteredChannel,
    stats: ReadonlyMap<string, ChannelDeliveryStats>,
  ): ChannelView {
    const r = entry.record;
    const s = stats.get(r.channelId);
    const missing = this.missingOf(r);
    const problem =
      missing.length > 0
        ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in the environment BrowserHive runs in.`
        : (entry.problem ?? webhookWarning(r));
    return {
      channel_id: r.channelId,
      name: r.name,
      kind: AvailableChannelKind.safeParse(r.kind).success
        ? (r.kind as ChannelView['kind'])
        : 'webhook',
      mode: r.mode,
      source: r.source,
      status: r.status,
      target: { ...r.target },
      target_hint: targetHint(r),
      secret_refs: { ...r.secretRefs },
      secrets: Object.entries(r.secretRefs).map(([param, env]) => ({
        param,
        env,
        set: this.isSet(env),
      })),
      rules: r.rules,
      capabilities: entry.capabilities === null ? null : capabilitiesDto(entry.capabilities),
      ready: entry.adapter !== null && missing.length === 0,
      problem,
      failure_count: r.failureCount,
      last_error: r.lastError,
      last_ok_at: r.lastOkAt,
      last_failure_at: r.lastFailureAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      stats: {
        sent_24h: s?.sent ?? 0,
        failed_24h: s?.failed ?? 0,
        suppressed_24h: s?.suppressed ?? 0,
        pending: s?.pending ?? 0,
        last_delivery_at: s?.lastAt ?? null,
        last_status: s?.lastStatus ?? null,
      },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------------------------

  private validate(input: {
    readonly kind: string;
    readonly mode: string | null;
    readonly target: Readonly<Record<string, string>>;
    readonly secretRefs: Readonly<Record<string, string>>;
    readonly rules: NotificationChannelRules;
  }): void {
    if (input.kind === 'discord' && input.mode === 'bot') {
      throw new AppError('CHANNEL_KIND_UNAVAILABLE', {
        kind: 'discord',
        mode: 'bot',
        mode_text: ' in bot mode',
      });
    }
    const issues = checkChannelConfig({
      kind: input.kind,
      mode: input.mode,
      target: input.target,
      secretRefs: input.secretRefs,
    }).map((p) => ({ path: p.field, message: p.message, code: 'custom' }));
    if (input.kind === 'telegram') {
      for (const [category, ms] of Object.entries(input.rules.ttl_ms ?? {})) {
        if (ms !== undefined && ms > TELEGRAM_TTL_MAX_MS) {
          issues.push({
            path: `rules.ttl_ms.${category}`,
            message:
              'Telegram lets a bot delete its messages for 48 hours only; choose 47 h or less.',
            code: 'custom',
          });
        }
      }
    }
    const images = Object.entries(input.rules.images ?? {}).some(([, on]) => on === true);
    if (images && contentLevelOf(input.rules) !== 'full') {
      issues.push({
        path: 'rules.images',
        message: 'Screenshots need the content level "full".',
        code: 'custom',
      });
    }
    if (issues.length > 0) throw new AppError('VALIDATION_FAILED', { issues });
  }

  private async assertNameFree(name: string, except: string | null): Promise<void> {
    const clash = await this.deps.repos.notificationChannels.getByName(name);
    if (clash !== null && clash.channelId !== except) {
      throw new AppError('CHANNEL_NAME_TAKEN', { name });
    }
  }

  /**
   * Creates a dashboard channel.
   *
   * @throws AppError `VALIDATION_FAILED`, `CHANNEL_NAME_TAKEN`, `CHANNEL_KIND_UNAVAILABLE`.
   */
  async create(input: ChannelInput): Promise<ChannelView> {
    const spec = CHANNEL_KIND_SPECS[input.kind];
    const mode = input.mode ?? spec.defaultMode;
    this.validate({
      kind: input.kind,
      mode,
      target: input.target,
      secretRefs: input.secret_refs,
      rules: input.rules,
    });
    await this.assertNameFree(input.name, null);
    const now = this.deps.clock.now();
    const channelId = `nc-${this.deps.ids.opaque(12)}`;
    await this.deps.repos.notificationChannels.upsert({
      channelId,
      name: input.name,
      kind: input.kind,
      mode,
      source: 'db',
      status: 'active',
      target: input.target,
      secretRefs: input.secret_refs,
      rules: input.rules,
      failureCount: 0,
      lastError: null,
      lastOkAt: null,
      lastFailureAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.deps.registry.reload();
    this.log.info('channel created', { channel: input.name, kind: input.kind });
    const view = await this.get(channelId);
    this.publishChannelNow(view);
    return view;
  }

  /**
   * Edits a dashboard channel (not its kind).
   *
   * @throws AppError `CHANNEL_NOT_FOUND`, `CHANNEL_READ_ONLY`, `VALIDATION_FAILED`, `CHANNEL_NAME_TAKEN`.
   */
  async update(channelId: string, patch: ChannelPatch): Promise<ChannelView> {
    const current = this.entry(channelId).record;
    if (current.source === 'startup') {
      throw new AppError('CHANNEL_READ_ONLY', { channel_id: channelId, name: current.name });
    }
    const next: NotificationChannelRecord = {
      ...current,
      name: patch.name ?? current.name,
      mode: patch.mode === undefined ? current.mode : patch.mode,
      target: patch.target ?? current.target,
      secretRefs: patch.secret_refs ?? current.secretRefs,
      rules: patch.rules ?? current.rules,
      updatedAt: this.deps.clock.now(),
    };
    this.validate({
      kind: next.kind,
      mode: next.mode,
      target: next.target,
      secretRefs: next.secretRefs,
      rules: next.rules,
    });
    if (next.name !== current.name) await this.assertNameFree(next.name, channelId);
    await this.deps.repos.notificationChannels.upsert(next);
    await this.deps.registry.reload();
    this.log.info('channel updated', { channel: next.name });
    const view = await this.get(channelId);
    this.publishChannelNow(view);
    return view;
  }

  /**
   * Deletes a dashboard channel with its delivery log.
   *
   * @throws AppError `CHANNEL_NOT_FOUND`, `CHANNEL_READ_ONLY`.
   */
  async remove(channelId: string): Promise<void> {
    const current = this.entry(channelId).record;
    if (current.source === 'startup') {
      throw new AppError('CHANNEL_READ_ONLY', { channel_id: channelId, name: current.name });
    }
    await this.deps.repos.notificationChannels.remove(channelId);
    await this.deps.registry.reload();
    this.log.info('channel removed', { channel: current.name });
    this.deps.bus.publish('channel.removed', { type: 'channel.removed', channel_id: channelId });
  }

  /**
   * Pauses a channel (startup channels too; the pause survives restarts): its pending jobs are
   * suppressed with `channel_paused`.
   */
  async pause(channelId: string): Promise<ChannelView> {
    const entry = this.entry(channelId);
    const now = this.deps.clock.now();
    await this.deps.uow.transaction(async (r) => {
      await r.notificationChannels.setStatus(channelId, 'paused', now);
      await r.notificationDeliveries.suppressChannel(channelId, 'channel_paused', now);
    });
    await this.deps.registry.reload();
    this.statusChanged(entry, 'paused', now);
    const view = await this.get(channelId);
    this.publishChannelNow(view);
    return view;
  }

  /** Resumes a paused or broken channel (consecutive failures reset). */
  async resume(channelId: string): Promise<ChannelView> {
    const entry = this.entry(channelId);
    const now = this.deps.clock.now();
    await this.deps.repos.notificationChannels.setStatus(channelId, 'active', now);
    await this.deps.registry.reload();
    this.statusChanged(entry, 'active', now);
    const view = await this.get(channelId);
    this.publishChannelNow(view);
    return view;
  }

  private statusChanged(entry: RegisteredChannel, status: 'active' | 'paused', at: number): void {
    if (entry.record.status === status) return;
    this.log.info('channel status changed', { channel: entry.record.name, status });
    this.deps.bus.publish('notification.channel.changed', {
      type: 'notification.channel.changed',
      channel_id: entry.record.channelId,
      name: entry.record.name,
      kind: entry.record.kind,
      status,
      previous_status: entry.record.status,
      failure_count: 0,
      last_error: null,
      at,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Test send and preview
  // ---------------------------------------------------------------------------------------------

  /** The message as a channel receives it: content level, image rule, degrade. */
  private shape(
    message: NotificationMessage,
    rules: NotificationChannelRules,
    capabilities: ChannelCapabilities,
  ): NotificationMessage {
    return degrade(
      applyImageRule(restrictContent(message, contentLevelOf(rules)), rules),
      capabilities,
    );
  }

  /**
   * Sends a `test` notification through the channel now (outside the outbox queue) and records it
   * in the delivery log (spec 03 §4.8.1).
   *
   * @throws AppError `CHANNEL_NOT_FOUND`, `CHANNEL_NOT_READY`.
   */
  async test(channelId: string): Promise<ChannelTestResponse> {
    const entry = this.entry(channelId);
    const adapter = entry.adapter;
    const capabilities = entry.capabilities;
    const missing = this.missingOf(entry.record);
    if (adapter === null || capabilities === null || missing.length > 0) {
      throw new AppError('CHANNEL_NOT_READY', {
        channel_id: channelId,
        problem:
          missing.length > 0
            ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`
            : (entry.problem ?? 'the channel has no adapter.'),
        missing,
      });
    }
    const now = this.deps.clock.now();
    const notificationId = `n-${this.deps.ids.opaque(12)}`;
    const sample = sampleMessage('test', { now });
    const message: NotificationMessage = {
      ...sample,
      id: notificationId,
      thread: `test:${channelId}`,
    };
    const record: NotificationRecord = {
      notificationId,
      principalId: null,
      type: 'system',
      title: message.title,
      body: message.summary,
      sessionId: null,
      target: '/notifications/channels',
      sourceEventId: null,
      createdAt: now,
      updatedAt: now,
      count: 1,
      groupKey: null,
      readAt: now,
      dismissedAt: now,
      kind: message.kind,
      category: message.category,
      severity: message.severity,
      state: message.state,
      revision: 1,
      thread: message.thread,
      messageJson: encodeMessage(message),
    };
    await this.deps.uow.transaction(async (r) => {
      await r.notifications.insert(record);
      await r.notificationDeliveries.enqueue([
        {
          channelId,
          notificationId,
          revision: 1,
          op: 'send',
          status: 'pending',
          reason: 'test',
          nextAttemptAt: null,
          createdAt: now,
        },
      ]);
    });
    const job = (
      await this.deps.repos.notificationDeliveries.list({ channelId, notificationId, limit: 1 })
    )[0];
    if (job === undefined) throw new Error('test delivery was not recorded');
    await this.deps.repos.notificationDeliveries.claim(job.seq, now);
    const delivery: ChannelDelivery = {
      message: this.shape(message, entry.record.rules, capabilities),
      links: this.deps.links,
      replyTo: null,
    };
    const started = this.deps.clock.now();
    let error: { code: string; message: string } | null = null;
    try {
      const result = await adapter.send(delivery);
      const done = this.deps.clock.now();
      const rules = entry.record.rules;
      let expiresAt = expiryFor(rules, message, done);
      if (deleteWhenResolved(rules, message)) expiresAt = done;
      await this.deps.uow.transaction(async (r) => {
        await r.notificationDeliveries.finish(job.seq, {
          status: 'sent',
          reason: 'test',
          lastError: null,
          durationMs: Math.max(0, done - started),
          messageRef: result.ref,
          updatedAt: done,
        });
        await r.notificationChannelMessages.upsert({
          channelId,
          notificationId,
          thread: message.thread,
          messageRef: result.ref,
          lastRevision: 1,
          sentAt: done,
          updatedAt: done,
          expiresAt,
          deletedAt: null,
        });
      });
      this.log.info('channel test sent', { channel: entry.record.name });
    } catch (err) {
      const done = this.deps.clock.now();
      const code = err instanceof ChannelSendError ? err.code : 'unavailable';
      const text = this.scrub(
        err instanceof ChannelSendError ? err.message : serializeError(err).message,
      );
      error = { code, message: text };
      await this.deps.repos.notificationDeliveries.finish(job.seq, {
        status: 'dead',
        reason: code,
        lastError: `${code}: ${text}`,
        durationMs: Math.max(0, done - started),
        updatedAt: done,
      });
      this.log.warn('channel test failed', { channel: entry.record.name, code });
    }
    const row = await this.deps.repos.notificationDeliveries.get(job.seq);
    const dto = row === null ? null : await this.deliveryRow(row, new Map());
    if (dto !== null)
      this.deps.bus.publish('delivery.updated', { type: 'delivery.updated', delivery: dto });
    this.scheduleChannel(channelId);
    return { ok: error === null, delivery: dto, error };
  }

  private scrub(text: string): string {
    return clip(this.deps.redactor?.scrubText(text) ?? text, ERROR_MAX);
  }

  /**
   * Renders a sample notification exactly as the channel (saved, or a draft) would send it.
   * Pure: nothing is sent and nothing is stored.
   *
   * @throws AppError `CHANNEL_NOT_FOUND`, `CHANNEL_KIND_UNAVAILABLE`.
   */
  preview(request: ChannelPreviewRequest): ChannelPreview {
    let kind: string;
    let mode: string | null;
    let target: Readonly<Record<string, string>>;
    let rules: NotificationChannelRules;
    let secretRefs: Readonly<Record<string, string>> = {};
    if (request.channel_id !== undefined) {
      const r = this.entry(request.channel_id).record;
      kind = r.kind;
      mode = r.mode;
      target = r.target;
      rules = r.rules;
      secretRefs = r.secretRefs;
    } else {
      kind = request.kind ?? 'webhook';
      const spec = CHANNEL_KIND_SPECS[request.kind ?? 'webhook'];
      mode = request.mode ?? spec.defaultMode;
      target = request.target ?? {};
      rules = request.rules ?? {};
    }
    const renderer = this.deps.renderers.get(kind);
    const parsedKind = AvailableChannelKind.safeParse(kind);
    if (renderer === undefined || !parsedKind.success) {
      throw new AppError('CHANNEL_KIND_UNAVAILABLE', { kind, mode_text: '' });
    }
    const capabilities = renderer.capabilities(mode);
    const now = this.deps.clock.now();
    const plain = sampleMessage(request.sample, { now });
    const withImage = wantsImages(rules, plain.category)
      ? sampleMessage(request.sample, {
          now,
          image: rules.mask_images === true ? 'masked' : 'unmasked',
        })
      : plain;
    const shown = this.shape(withImage, rules, capabilities);
    const rendered = renderer.render(
      { message: shown, links: this.deps.links, replyTo: null },
      { mode, target, op: 'send', ref: null, actToken: (id) => `bh1:preview-${id}` },
    );
    const spec = CHANNEL_KIND_SPECS[parsedKind.data];
    const envOf = (param: string) =>
      secretRefs[param] ??
      spec.secrets.find((s) => s.param === param)?.suggestedEnv ??
      param.toUpperCase();
    // A secret parameter appears as `{secret:<param>}` (a path, an ntfy topic); show its variable.
    const named = (text: string) =>
      text.replace(/\{secret:([a-z_]+)\}/g, (_m, param: string) => `{${envOf(param)}}`);
    const requests: PlatformRequest[] = rendered.map((r) => ({
      method: r.method,
      path: named(r.path),
      encoding: r.encoding,
      body: JSON.parse(named(JSON.stringify(r.body))) as Record<string, unknown>,
      headers: JSON.parse(named(JSON.stringify(r.headers))) as Record<string, string>,
      file: r.file === null ? null : { name: r.file.name, content_type: r.file.content_type },
    }));
    return {
      kind: parsedKind.data,
      mode,
      sample: request.sample,
      capabilities: capabilitiesDto(capabilities),
      message: shown,
      requests,
      local_links: this.deps.links.local,
      notes: this.notes(parsedKind.data, rules, capabilities, plain.category, request.sample),
    };
  }

  private notes(
    kind: string,
    rules: NotificationChannelRules,
    caps: ChannelCapabilities,
    category: NotificationCategory,
    sample: PreviewSample,
  ): string[] {
    const notes: string[] = [];
    if (this.deps.links.local) {
      notes.push(
        'publicUrl is not set: links point at this computer and will not open on a phone.',
      );
    }
    if (!caps.actButtons && (sample === 'attention' || sample === 'vault-confirm')) {
      notes.push(
        'Approve/Reject buttons arrive with act buttons; until then they open BrowserHive.',
      );
    }
    if (rules.images?.[category] === true && !wantsImages(rules, category)) {
      notes.push('Screenshots are on, but they need the content level "full".');
    }
    if (kind === 'ntfy' && wantsImages(rules, category)) {
      const server = NTFY_DEFAULT_SERVER;
      notes.push(
        `On ${server.replace('https://', '')} attachments are stored on the public server for 3 hours; a self-hosted ntfy keeps screenshots private.`,
      );
    }
    return notes;
  }

  // ---------------------------------------------------------------------------------------------
  // Delivery log
  // ---------------------------------------------------------------------------------------------

  /** A page of the delivery log, newest first. */
  async deliveries(input: DeliveryListInput): Promise<DeliveryPage> {
    const beforeSeq = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const rows = await this.deps.repos.notificationDeliveries.list({
      ...(input.channelId !== undefined && { channelId: input.channelId }),
      ...(input.notificationId !== undefined && { notificationId: input.notificationId }),
      ...(input.statuses !== undefined && { statuses: input.statuses }),
      ...(input.ops !== undefined && { ops: input.ops }),
      ...(input.kinds !== undefined && { kinds: input.kinds }),
      ...(beforeSeq !== undefined && { beforeSeq }),
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const cache = new Map<string, NotificationRecord | null>();
    const items: DeliveryRow[] = [];
    for (const row of page) items.push(await this.deliveryRow(row, cache));
    const lastRow = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > input.limit && lastRow !== undefined ? encodeCursor(lastRow.seq) : null,
    };
  }

  /**
   * One delivery with the notification's current message as that channel is shown it.
   *
   * @throws AppError `DELIVERY_NOT_FOUND`.
   */
  async delivery(
    seq: number,
  ): Promise<{ delivery: DeliveryRow; message: NotificationMessage | null }> {
    const row = await this.deps.repos.notificationDeliveries.get(seq);
    if (row === null) throw new AppError('DELIVERY_NOT_FOUND', { seq });
    const cache = new Map<string, NotificationRecord | null>();
    const dto = await this.deliveryRow(row, cache);
    const record = cache.get(row.notificationId) ?? null;
    const message = record === null ? null : decodeMessage(record.messageJson);
    const entry = this.deps.registry.get(row.channelId);
    let shown: NotificationMessage | null = message;
    if (message !== null && entry !== undefined) {
      shown =
        entry.capabilities === null
          ? restrictContent(message, contentLevelOf(entry.record.rules))
          : this.shape(message, entry.record.rules, entry.capabilities);
    }
    return { delivery: dto, message: shown };
  }

  private async deliveryRow(
    row: NotificationDeliveryRecord,
    cache: Map<string, NotificationRecord | null>,
  ): Promise<DeliveryRow> {
    let n = cache.get(row.notificationId);
    if (n === undefined) {
      n = await this.deps.repos.notifications.get(row.notificationId);
      cache.set(row.notificationId, n);
    }
    const channel = this.deps.registry.get(row.channelId)?.record;
    return DeliveryRowSchema.parse({
      seq: row.seq,
      channel_id: row.channelId,
      channel_name: channel?.name ?? null,
      channel_kind: channel?.kind ?? null,
      notification_id: row.notificationId,
      notification_kind: n?.kind ?? null,
      notification_title: n?.title ?? null,
      revision: row.revision,
      op: row.op,
      status: row.status,
      reason: row.reason,
      attempts: row.attempts,
      next_attempt_at: row.nextAttemptAt,
      last_error: row.lastError,
      duration_ms: row.durationMs,
      message_ref: row.messageRef === null ? null : { ...row.messageRef },
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Environment check and Telegram connect
  // ---------------------------------------------------------------------------------------------

  /** Whether each named variable is set and non-empty (never its value). */
  env(names: readonly string[]): { name: string; set: boolean }[] {
    return names.map((name) => ({ name, set: this.isSet(name) }));
  }

  /**
   * Starts the Telegram connect flow: checks the token with `getMe`, then waits up to two minutes
   * for `/start <code>` (setup-only long polling). A new connect for the same variable cancels the
   * previous one.
   *
   * @throws AppError `CHANNEL_NOT_READY` (unset variable), `CHANNEL_PLATFORM_ERROR`.
   */
  async telegramConnect(tokenEnv: string): Promise<TelegramConnectResponse> {
    const telegram = this.deps.telegram;
    if (telegram === undefined) {
      throw new AppError('CHANNEL_KIND_UNAVAILABLE', { kind: 'telegram', mode_text: '' });
    }
    const token = this.deps.env(tokenEnv);
    if (token === undefined || token === '') {
      throw new AppError('CHANNEL_NOT_READY', {
        problem: `${tokenEnv} is not set.`,
        missing: [tokenEnv],
      });
    }
    this.deps.registerSecret?.(token);
    let username: string;
    try {
      username = await telegram.botUsername(token);
    } catch (err) {
      const code = err instanceof ChannelSendError ? err.code : 'unavailable';
      throw new AppError('CHANNEL_PLATFORM_ERROR', {
        kind: 'telegram',
        code,
        detail: this.scrub(serializeError(err).message),
      });
    }
    this.pruneConnects();
    for (const session of this.connects.values()) {
      if (session.tokenEnv === tokenEnv && session.status === 'waiting') {
        session.abort.abort();
        session.status = 'expired';
        session.endedAt = this.deps.clock.now();
      }
    }
    const id = this.deps.ids.opaque(16);
    const code = this.deps.ids.opaque(16);
    const expiresAt = this.deps.clock.now() + TELEGRAM_CONNECT_MS;
    const session: ConnectSession = {
      id,
      tokenEnv,
      botUsername: username,
      expiresAt,
      abort: new AbortController(),
      status: 'waiting',
      start: null,
      error: null,
      endedAt: null,
    };
    this.connects.set(id, session);
    void telegram
      .waitForStart(token, code, { signal: session.abort.signal, deadline: expiresAt })
      .then((start) => {
        if (session.status !== 'waiting') return;
        session.start = start;
        session.status = start === null ? 'expired' : 'connected';
        session.endedAt = this.deps.clock.now();
        if (start !== null) this.log.info('telegram chat connected', { type: start.chat.type });
      })
      .catch((err: unknown) => {
        if (session.status !== 'waiting') return;
        session.status = 'failed';
        session.error = this.scrub(serializeError(err).message);
        session.endedAt = this.deps.clock.now();
      });
    return {
      connect_id: id,
      bot_username: username,
      link: `https://t.me/${username}?start=${code}`,
      group_link: `https://t.me/${username}?startgroup=${code}`,
      expires_at: expiresAt,
    };
  }

  /**
   * The state of one connect flow.
   *
   * @throws AppError `NOT_FOUND` for an unknown or forgotten id.
   */
  telegramConnectStatus(connectId: string): TelegramConnectStatus {
    this.pruneConnects();
    const session = this.connects.get(connectId);
    if (session === undefined) throw new AppError('NOT_FOUND', {});
    if (session.status === 'waiting' && this.deps.clock.now() > session.expiresAt + 5_000) {
      session.status = 'expired';
      session.endedAt = this.deps.clock.now();
    }
    const start = session.start;
    return {
      status: session.status,
      chat:
        start === null
          ? null
          : {
              id: start.chat.id,
              title: start.chat.title,
              type: start.chat.type,
              thread_id: start.chat.threadId,
            },
      user: start?.user ?? null,
      error: session.error,
      expires_at: session.expiresAt,
    };
  }

  /** Cancels every connect flow (shutdown). */
  stop(): void {
    for (const session of this.connects.values()) session.abort.abort();
    this.connects.clear();
  }

  private pruneConnects(): void {
    const now = this.deps.clock.now();
    for (const [id, session] of this.connects) {
      if (session.endedAt !== null && now - session.endedAt > CONNECT_KEEP_MS)
        this.connects.delete(id);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Feed
  // ---------------------------------------------------------------------------------------------

  /**
   * Re-publishes the delivery rows of one notification (optionally on one channel) on the
   * `channels` topic, and schedules the affected channels' `channel.changed`. Never throws.
   */
  onDeliveryChange(notificationId: string, channelId?: string): void {
    void (async () => {
      const rows = await this.deps.repos.notificationDeliveries.list({
        notificationId,
        ...(channelId !== undefined && { channelId }),
        limit: FEED_ROWS,
      });
      const cache = new Map<string, NotificationRecord | null>();
      const latest = new Map<string, NotificationDeliveryRecord>();
      for (const row of rows) {
        const key = `${row.channelId}:${row.op}`;
        if (!latest.has(key)) latest.set(key, row);
      }
      for (const row of latest.values()) {
        const dto = await this.deliveryRow(row, cache);
        this.deps.bus.publish('delivery.updated', { type: 'delivery.updated', delivery: dto });
        this.scheduleChannel(row.channelId);
      }
    })().catch((err: unknown) =>
      this.log.warn('delivery feed failed', { err: serializeError(err) }),
    );
  }

  private publishChannelNow(view: ChannelView): void {
    this.deps.bus.publish('channel.changed', { type: 'channel.changed', channel: view });
  }

  /** Debounced `channel.changed` (stats moved). */
  scheduleChannel(channelId: string): void {
    this.pendingChannels.add(channelId);
    if (this.channelTimer) return;
    this.channelTimer = true;
    const schedule =
      this.deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
    schedule(() => {
      this.channelTimer = false;
      const ids = [...this.pendingChannels];
      this.pendingChannels.clear();
      void this.stats()
        .then((stats) => {
          for (const id of ids) {
            const entry = this.deps.registry.get(id);
            if (entry !== undefined) this.publishChannelNow(this.view(entry, stats));
          }
        })
        .catch((err: unknown) =>
          this.log.warn('channel feed failed', { err: serializeError(err) }),
        );
    }, CHANNEL_FEED_DEBOUNCE_MS);
  }
}

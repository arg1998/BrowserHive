/** @module app/notifications/channel-registry — the configured notification channels and their adapters (spec 03 §9.3, D-33, D-39): loads `notification_channels`, projects the startup channels into it (read-only, name clash = `CONFIG_INVALID`), builds one adapter per channel through the factories composition registers per kind. */

import type { StartupNotificationChannel } from '@browserhive/contracts/notifications';
import { AppError } from '../../kernel/errors/app-error.ts';
import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { NotificationChannel } from '../../ports/notification-channel.ts';
import type { NotificationChannelStatus } from '../../ports/persistence/enums.ts';
import type { NotificationChannelRepository } from '../../ports/persistence/notification-outbox.ts';
import type { NotificationChannelRecord } from '../../ports/persistence/records.ts';
import type { RoutableChannel } from './routing.ts';

/** What an adapter factory receives besides the channel row. */
export interface ChannelFactoryContext {
  /**
   * Value of a secret environment variable named in the channel's `secretRefs` (D-33), or `null`
   * when it is unset or empty. Every value returned is registered with the redactor first, so it
   * can never reach a log line, a stored message or the delivery log.
   */
  secret(envName: string): string | null;
}

/** Builds the adapter of one channel row. Throwing marks the channel as having no adapter. */
export type ChannelAdapterFactory = (
  channel: NotificationChannelRecord,
  context: ChannelFactoryContext,
) => NotificationChannel;

/** A channel with its adapter (`null` when no factory exists for its kind or the factory failed). */
export interface RegisteredChannel extends RoutableChannel {
  readonly adapter: NotificationChannel | null;
}

/** Dependencies of {@link ChannelRegistry}. */
export interface ChannelRegistryDeps {
  readonly repo: NotificationChannelRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** One factory per `NotificationChannelKind`; none are registered until platform adapters ship. */
  readonly factories?: ReadonlyMap<string, ChannelAdapterFactory>;
  /** Reads an environment variable (composition passes the host environment). */
  readonly env?: (name: string) => string | undefined;
  /** Registers a resolved secret with the redactor (`SecretRegistry.add`). */
  readonly registerSecret?: (value: string) => void;
}

/**
 * The in-memory view of `notification_channels` the planner and the outbox read on every change,
 * so a notification with no external channel costs no query. Reload after any change to the table.
 */
export class ChannelRegistry {
  private entries: RegisteredChannel[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly log: Logger;

  constructor(private readonly deps: ChannelRegistryDeps) {
    this.log = deps.logger.child({ module: 'notifications' });
  }

  /**
   * Projects the startup channels (D-39) and loads every channel. A startup channel whose name a
   * dashboard channel already uses throws `CONFIG_INVALID` (exit 64); startup rows no longer
   * declared are removed with their delivery log; the configuration of the others is rewritten
   * while their status and breaker counters are kept.
   */
  async load(startup: readonly StartupNotificationChannel[] = []): Promise<void> {
    const now = this.deps.clock.now();
    const existing = await this.deps.repo.list();
    const declared = new Set(startup.map((s) => s.name));
    for (const spec of startup) {
      const row = existing.find((r) => r.name === spec.name);
      if (row !== undefined && row.source !== 'startup') {
        throw new AppError(
          'CONFIG_INVALID',
          {
            key: 'notificationChannel',
            source: 'cli',
            reason: `notification channel '${spec.name}' is defined by --notificationChannel and in the dashboard. Rename one of them.`,
          },
          {
            message: `notification channel '${spec.name}' is defined by --notificationChannel and in the dashboard. Rename one of them.`,
          },
        );
      }
      await this.deps.repo.upsert({
        channelId: row?.channelId ?? `nc-${this.deps.ids.opaque(12)}`,
        name: spec.name,
        kind: spec.kind,
        mode: spec.mode,
        source: 'startup',
        status: row?.status ?? 'active',
        target: spec.target,
        secretRefs: spec.secret_refs,
        rules: spec.rules,
        failureCount: row?.failureCount ?? 0,
        lastError: row?.lastError ?? null,
        lastOkAt: row?.lastOkAt ?? null,
        lastFailureAt: row?.lastFailureAt ?? null,
        createdAt: row?.createdAt ?? now,
        updatedAt: now,
      });
    }
    for (const row of existing) {
      if (row.source === 'startup' && !declared.has(row.name)) {
        await this.deps.repo.remove(row.channelId);
        this.log.info('startup channel removed', { channel: row.name });
      }
    }
    await this.reload();
  }

  /** Re-reads the table and rebuilds adapters; listeners run after. */
  async reload(): Promise<void> {
    const rows = await this.deps.repo.list();
    this.entries = rows.map((record) => ({
      record,
      ...this.build(record),
    }));
    for (const fn of this.listeners) fn();
  }

  /** Every configured external channel (the in-app inbox is not one of them). */
  channels(): readonly RegisteredChannel[] {
    return this.entries;
  }

  /** One channel by id. */
  get(channelId: string): RegisteredChannel | undefined {
    return this.entries.find((e) => e.record.channelId === channelId);
  }

  /** True when at least one external channel is configured (the outbox runs only then). */
  hasChannels(): boolean {
    return this.entries.length > 0;
  }

  /** Updates the cached status of one channel after the outbox changed it in the table. */
  setCachedStatus(
    channelId: string,
    status: NotificationChannelStatus,
    failureCount: number,
  ): void {
    this.entries = this.entries.map((e) =>
      e.record.channelId === channelId
        ? { ...e, record: { ...e.record, status, failureCount } }
        : e,
    );
  }

  /** Runs `fn` after every reload; returns the unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private build(record: NotificationChannelRecord): Omit<RegisteredChannel, 'record'> {
    const factory = this.deps.factories?.get(record.kind);
    if (factory === undefined) return { adapter: null, capabilities: null };
    const context: ChannelFactoryContext = {
      secret: (envName) => {
        const value = this.deps.env?.(envName);
        if (value === undefined || value === '') return null;
        this.deps.registerSecret?.(value);
        return value;
      },
    };
    try {
      const adapter = factory(record, context);
      return { adapter, capabilities: adapter.capabilities };
    } catch (err) {
      this.log.warn('channel adapter failed', { channel: record.name, err: serializeError(err) });
      return { adapter: null, capabilities: null };
    }
  }
}

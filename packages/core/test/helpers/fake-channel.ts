/** @module test/helpers/fake-channel — a scripted `NotificationChannel` that records every call, plus channel-row and capability builders for the notification outbox suites (spec 09). */

import type {
  ChannelCapabilities,
  ChannelDelivery,
  ChannelSendResult,
  NotificationChannel,
  PlatformMessageRef,
} from '../../src/ports/notification-channel.ts';
import type { NotificationChannelRecord } from '../../src/ports/persistence/records.ts';

/** Capabilities of a capable chat platform (Telegram-like): everything but tables. */
export function capabilities(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    richBlocks: true,
    tables: false,
    charts: false,
    images: true,
    actButtons: false,
    openLinks: true,
    edit: true,
    delete: true,
    replies: true,
    deleteWindowMs: null,
    maxTitleChars: 120,
    maxTextChars: 4000,
    maxButtons: 3,
    ...overrides,
  };
}

/** The default capabilities, reachable where a parameter named `capabilities` shadows the builder. */
const defaultCapabilities = (): ChannelCapabilities => capabilities();

/** A `notification_channels` row with sensible defaults. */
export function channelRecord(
  overrides: Partial<NotificationChannelRecord> = {},
): NotificationChannelRecord {
  return {
    channelId: 'nc-000000000001',
    name: 'phone',
    kind: 'fake',
    mode: null,
    source: 'db',
    status: 'active',
    target: { chat: '1' },
    secretRefs: { token: 'BH_FAKE_TOKEN' },
    rules: {},
    failureCount: 0,
    lastError: null,
    lastOkAt: null,
    lastFailureAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** One recorded platform call. */
export interface FakeCall {
  readonly op: 'send' | 'edit' | 'delete';
  readonly ref: PlatformMessageRef | null;
  readonly delivery: ChannelDelivery | null;
}

/** An outcome queued for the next call: `ok` or an error to throw. */
export type FakeOutcome = 'ok' | Error;

/**
 * Records calls and answers them from a queue (`'ok'` when empty). Refs are `{ message_id: n }`
 * with a counter per send.
 */
export class FakeChannel implements NotificationChannel {
  readonly calls: FakeCall[] = [];
  readonly outcomes: FakeOutcome[] = [];
  private messages = 0;

  constructor(
    readonly id = 'nc-000000000001',
    readonly capabilities: ChannelCapabilities = defaultCapabilities(),
    readonly name = 'phone',
    readonly kind = 'fake',
  ) {}

  /** Queues outcomes for the next calls. */
  script(...outcomes: FakeOutcome[]): this {
    this.outcomes.push(...outcomes);
    return this;
  }

  private next(): void {
    const outcome = this.outcomes.shift() ?? 'ok';
    if (outcome !== 'ok') throw outcome;
  }

  async send(delivery: ChannelDelivery): Promise<ChannelSendResult> {
    this.calls.push({ op: 'send', ref: null, delivery });
    this.next();
    this.messages += 1;
    return { ref: { message_id: this.messages } };
  }

  async edit(ref: PlatformMessageRef, delivery: ChannelDelivery): Promise<ChannelSendResult> {
    this.calls.push({ op: 'edit', ref, delivery });
    this.next();
    return { ref };
  }

  async delete(ref: PlatformMessageRef): Promise<void> {
    this.calls.push({ op: 'delete', ref, delivery: null });
    this.next();
  }

  /** Calls of one op. */
  ops(op: FakeCall['op']): FakeCall[] {
    return this.calls.filter((c) => c.op === op);
  }
}

/** @module app/notifications/action-listeners — keeps one press listener per channel with act buttons (spec 03 §9.6, D-41): follows the registry, hands presses to the action service, and tracks each listener's state for the channel cards. */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Logger } from '../../ports/logger.ts';
import type {
  ListenerStatus,
  PressHandler,
  PressSource,
} from '../../ports/notification-channel.ts';
import type { ChannelRegistry } from './channel-registry.ts';

/** Dependencies of {@link NotificationActionListeners}. */
export interface NotificationActionListenersDeps {
  readonly registry: ChannelRegistry;
  /** Handles every press (the action service's `press`). */
  readonly handler: PressHandler;
  readonly logger: Logger;
  /** Called after a channel's listener changed state (re-publishes the channel). Must not throw. */
  readonly onStatus?: (channelId: string) => void;
}

interface Running {
  readonly source: PressSource;
  readonly stop: () => void;
  status: ListenerStatus;
}

/**
 * The press listeners of every channel whose adapter receives presses (an adapter declares
 * `presses` only while its channel's act buttons are on). A registry reload rebuilds adapters; a
 * listener is replaced only when its adapter's source changed, and the shared connections behind
 * the sources outlive a quick stop-and-start.
 */
export class NotificationActionListeners {
  private readonly running = new Map<string, Running>();
  private readonly log: Logger;
  private offRegistry: (() => void) | undefined;

  constructor(private readonly deps: NotificationActionListenersDeps) {
    this.log = deps.logger.child({ module: 'notifications' });
  }

  /** Starts listening for the current channels and follows registry reloads. Idempotent. */
  start(): void {
    if (this.offRegistry !== undefined) return;
    this.offRegistry = this.deps.registry.onChange(() => this.sync());
    this.sync();
  }

  /** Stops every listener. Idempotent. */
  stop(): void {
    this.offRegistry?.();
    this.offRegistry = undefined;
    for (const [channelId, run] of this.running) this.halt(channelId, run);
    this.running.clear();
  }

  /** The state of a channel's listener, or `null` when it has none. */
  status(channelId: string): ListenerStatus | null {
    return this.running.get(channelId)?.status ?? null;
  }

  private sync(): void {
    const wanted = new Map<string, PressSource>();
    for (const entry of this.deps.registry.channels()) {
      const source = entry.adapter?.presses;
      if (source !== undefined && entry.record.rules.act_buttons === true) {
        wanted.set(entry.record.channelId, source);
      }
    }
    for (const [channelId, run] of this.running) {
      if (wanted.get(channelId) !== run.source) {
        this.halt(channelId, run);
        this.running.delete(channelId);
        this.changed(channelId);
      }
    }
    for (const [channelId, source] of wanted) {
      if (this.running.has(channelId)) continue;
      try {
        const stop = source.listen(this.deps.handler, (status) => {
          const current = this.running.get(channelId);
          if (current === undefined || current.source !== source) return;
          current.status = status;
          this.changed(channelId);
        });
        this.running.set(channelId, { source, stop, status: source.status() });
        this.changed(channelId);
      } catch (err) {
        this.log.warn('press listener failed', { channel_id: channelId, err: serializeError(err) });
      }
    }
  }

  private halt(channelId: string, run: Running): void {
    try {
      run.stop();
    } catch (err) {
      this.log.warn('press listener failed', { channel_id: channelId, err: serializeError(err) });
    }
  }

  private changed(channelId: string): void {
    try {
      this.deps.onStatus?.(channelId);
    } catch (err) {
      this.log.warn('press listener failed', { channel_id: channelId, err: serializeError(err) });
    }
  }
}

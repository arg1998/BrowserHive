/** @module app/events/bus — InProcessEventBus: synchronous publish, isolated consumers, async handlers fire-and-forget (spec 01 §5, 05 §6). */

import { serializeError } from '../../kernel/errors/serialize-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { DomainEvent, EventBus, EventHandler } from '../../ports/event-bus.ts';
import type { Logger } from '../../ports/logger.ts';
import type { DomainEvents } from './catalog.ts';

/** Dependencies of {@link InProcessEventBus}. */
export interface InProcessEventBusDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Called for every handler failure after it was logged (tests, degradation reporting). */
  readonly onHandlerError?: (error: unknown, event: DomainEvent) => void;
}

type AnyHandler = EventHandler<DomainEvent>;

/**
 * Typed in-process bus. `publish` is synchronous and delivers to named subscribers first (in
 * subscription order), then to `subscribeAll` subscribers — so the DB projection, subscribed
 * first, always enqueues before the WS feed sees the event (spec 01 §5). A throwing handler is
 * logged and never stops the others; a rejected promise is reported through `void p.catch(report)`.
 */
export class InProcessEventBus<Events extends Record<string, unknown> = DomainEvents>
  implements EventBus<Events>
{
  private readonly named = new Map<string, Set<AnyHandler>>();
  private readonly all = new Set<AnyHandler>();
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly onHandlerError: ((error: unknown, event: DomainEvent) => void) | undefined;

  constructor(deps: InProcessEventBusDeps) {
    this.clock = deps.clock;
    this.logger = deps.logger.child({ module: 'events' });
    this.onHandlerError = deps.onHandlerError;
  }

  publish<N extends keyof Events & string>(name: N, payload: Events[N]): void {
    const event: DomainEvent<N, Events[N]> = { name, at: this.clock.now(), payload };
    const handlers = [...(this.named.get(name) ?? []), ...this.all];
    for (const handler of handlers) this.deliver(handler, event);
  }

  subscribe<N extends keyof Events & string>(
    name: N,
    handler: EventHandler<DomainEvent<N, Events[N]>>,
  ): () => void {
    const set = this.named.get(name) ?? new Set<AnyHandler>();
    this.named.set(name, set);
    // The handler only ever receives events of `name`; widening the stored type is sound.
    const stored: AnyHandler = (event) =>
      handler({ name, at: event.at, payload: this.narrow(event) });
    set.add(stored);
    return () => {
      set.delete(stored);
    };
  }

  subscribeAll(
    handler: EventHandler<DomainEvent<keyof Events & string, Events[keyof Events]>>,
  ): () => void {
    const stored: AnyHandler = (event) =>
      handler({ name: this.name(event), at: event.at, payload: this.narrow(event) });
    this.all.add(stored);
    return () => {
      this.all.delete(stored);
    };
  }

  /** Number of subscribers that would receive `name` (named plus catch-all). */
  subscriberCount(name: keyof Events & string): number {
    return (this.named.get(name)?.size ?? 0) + this.all.size;
  }

  private narrow<N extends keyof Events & string>(event: DomainEvent): Events[N] {
    // Payloads are stored exactly as published; the map type guarantees the correspondence.
    const payload: unknown = event.payload;
    return payload as Events[N];
  }

  private name(event: DomainEvent): keyof Events & string {
    const name: string = event.name;
    return name as keyof Events & string;
  }

  private deliver(handler: AnyHandler, event: DomainEvent): void {
    try {
      const outcome = handler(event);
      if (outcome instanceof Promise) {
        void outcome.catch((error: unknown) => this.report(error, event));
      }
    } catch (error) {
      this.report(error, event);
    }
  }

  private report(error: unknown, event: DomainEvent): void {
    this.logger.error('event handler failed', { event: event.name, err: serializeError(error) });
    try {
      this.onHandlerError?.(error, event);
    } catch {
      // The error hook is itself untrusted; nothing more to do.
    }
  }
}

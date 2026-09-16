/** @module ports/event-bus — typed in-process domain event bus (spec 01 §5). Every mutation publishes here; consumers are isolated. */

/** A published domain event: versioned dotted name, epoch-ms timestamp, typed payload. */
export interface DomainEvent<N extends string = string, P = unknown> {
  readonly name: N;
  readonly at: number;
  readonly payload: P;
}

/** Handler for one event name. Throwing never affects other consumers (the bus isolates and logs). */
export type EventHandler<E extends DomainEvent> = (event: E) => void | Promise<void>;

/**
 * Publish/subscribe over a map of event name → payload type. The concrete map is
 * `DomainEvents` in `app/events/catalog.ts`; every subsystem appends its events there.
 */
export interface EventBus<Events extends Record<string, unknown>> {
  publish<N extends keyof Events & string>(name: N, payload: Events[N]): void;
  subscribe<N extends keyof Events & string>(
    name: N,
    handler: EventHandler<DomainEvent<N, Events[N]>>,
  ): () => void;
  /** Subscribes to every event (DB projection, WS feed). */
  subscribeAll(
    handler: EventHandler<DomainEvent<keyof Events & string, Events[keyof Events]>>,
  ): () => void;
}

/** The publish half of {@link EventBus}; producers depend on this so a wider bus fits a narrower map. */
export type EventPublisher<Events extends Record<string, unknown>> = Pick<
  EventBus<Events>,
  'publish'
>;

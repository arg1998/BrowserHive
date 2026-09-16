/** @module test/helpers/recording-event-bus — synchronous `EventBus` double that records every publish (spec 09 §4). */

import type { DomainEvent, EventBus, EventHandler } from '../../src/ports/event-bus.ts';

/** Records `{ name, payload }` in order and dispatches to subscribers synchronously. */
export class RecordingEventBus<Events extends Record<string, unknown>> implements EventBus<Events> {
  readonly published: { readonly name: string; readonly payload: unknown }[] = [];
  private readonly handlers = new Map<string, Set<EventHandler<DomainEvent>>>();
  private readonly all = new Set<EventHandler<DomainEvent>>();
  private at = 0;

  publish<N extends keyof Events & string>(name: N, payload: Events[N]): void {
    this.published.push({ name, payload });
    const event: DomainEvent = { name, at: this.at++, payload };
    for (const h of this.handlers.get(name) ?? []) void h(event);
    for (const h of this.all) void h(event);
  }

  subscribe<N extends keyof Events & string>(
    name: N,
    handler: EventHandler<DomainEvent<N, Events[N]>>,
  ): () => void {
    const set = this.handlers.get(name) ?? new Set();
    const generic: EventHandler<DomainEvent> = (e) =>
      handler({ name, at: e.at, payload: e.payload as Events[N] });
    set.add(generic);
    this.handlers.set(name, set);
    return () => set.delete(generic);
  }

  subscribeAll(
    handler: EventHandler<DomainEvent<keyof Events & string, Events[keyof Events]>>,
  ): () => void {
    const generic: EventHandler<DomainEvent> = (e) =>
      handler({
        name: e.name as keyof Events & string,
        at: e.at,
        payload: e.payload as Events[keyof Events],
      });
    this.all.add(generic);
    return () => this.all.delete(generic);
  }

  /** Names in publish order. */
  names(): string[] {
    return this.published.map((p) => p.name);
  }
}

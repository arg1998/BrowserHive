/** @module interface/mcp/transports/event-store — bounded in-memory SSE event store for `Last-Event-ID` resumption (spec 02 §1.2). */

import type { EventStore } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Events kept per stream (oldest dropped first). */
export const EVENT_STORE_MAX_EVENTS = 256;
/** Serialized bytes kept per stream (oldest dropped first). */
export const EVENT_STORE_MAX_BYTES = 1024 * 1024;

interface StoredEvent {
  readonly id: string;
  readonly seq: number;
  readonly message: JSONRPCMessage;
  readonly bytes: number;
}

interface Stream {
  readonly events: StoredEvent[];
  bytes: number;
  nextSeq: number;
}

const SEPARATOR = '~';

/** A ring per stream, bounded by {@link EVENT_STORE_MAX_EVENTS} and {@link EVENT_STORE_MAX_BYTES}. */
export class InMemoryEventStore implements EventStore {
  private readonly streams = new Map<string, Stream>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(limits: { maxEvents?: number; maxBytes?: number } = {}) {
    this.maxEvents = limits.maxEvents ?? EVENT_STORE_MAX_EVENTS;
    this.maxBytes = limits.maxBytes ?? EVENT_STORE_MAX_BYTES;
  }

  /** Stores an event and evicts the oldest past either bound. */
  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const stream = this.streams.get(streamId) ?? { events: [], bytes: 0, nextSeq: 1 };
    this.streams.set(streamId, stream);
    const seq = stream.nextSeq++;
    const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    const id = `${streamId}${SEPARATOR}${seq}`;
    stream.events.push({ id, seq, message, bytes });
    stream.bytes += bytes;
    while (
      stream.events.length > this.maxEvents ||
      (stream.bytes > this.maxBytes && stream.events.length > 1)
    ) {
      const dropped = stream.events.shift();
      if (dropped !== undefined) stream.bytes -= dropped.bytes;
    }
    return id;
  }

  /** The stream an event id belongs to. */
  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    const at = eventId.lastIndexOf(SEPARATOR);
    return at <= 0 ? undefined : eventId.slice(0, at);
  }

  /** Replays every retained event after `lastEventId` on its stream. */
  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const streamId = (await this.getStreamIdForEventId(lastEventId)) ?? '';
    const after = Number(lastEventId.slice(lastEventId.lastIndexOf(SEPARATOR) + 1));
    for (const event of this.streams.get(streamId)?.events ?? []) {
      if (event.seq > after) await send(event.id, event.message);
    }
    return streamId;
  }

  /** Number of retained events of a stream (tests). */
  size(streamId: string): number {
    return this.streams.get(streamId)?.events.length ?? 0;
  }
}

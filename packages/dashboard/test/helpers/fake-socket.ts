/** @module dashboard/test/helpers/fake-socket — scripted `WebSocketLike` + fake timers/clock for socket store tests */
import { WS_PROTOCOL_VERSION, WS_SUBPROTOCOL } from '@browserhive/contracts/ws';
import type { Timers } from '@/lib/clock.ts';
import { type WebSocketLike, WS_OPEN } from '@/lib/ws/store.ts';

/** A fake socket the test drives. */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;

  constructor(
    readonly url: string,
    readonly protocols: readonly string[],
  ) {}

  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }

  /** Server side: open the socket. */
  open(): void {
    this.readyState = WS_OPEN;
    this.onopen?.({});
  }

  /** Server side: deliver a text frame. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Server side: deliver a binary frame. */
  receiveBinary(bytes: Uint8Array): void {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    this.onmessage?.({ data: copy });
  }

  /** Server side: close from the server. */
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  /** Frames of a given type sent by the client. */
  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter(
      (f): f is Record<string, unknown> =>
        typeof f === 'object' && f !== null && (f as { type?: unknown }).type === type,
    );
  }

  /** Complete the handshake with a `hello`. */
  hello(epoch = 'e1', seq = 0): void {
    this.open();
    this.receive({
      v: 1,
      kind: 'reply',
      seq,
      ts: 1,
      payload: {
        type: 'hello',
        protocol: WS_SUBPROTOCOL,
        protocol_version: WS_PROTOCOL_VERSION,
        epoch,
        cursor: seq,
        server_version: '0.1.0',
        now: 1_700_000_000_000,
      },
    });
  }
}

/** Deterministic timers driven by `advance()`. */
export class FakeTimers implements Timers {
  now = 0;
  private id = 0;
  private readonly queue = new Map<number, { at: number; fn: () => void; every: number | null }>();

  setTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    this.id += 1;
    this.queue.set(this.id, { at: this.now + ms, fn, every: null });
    return this.id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (id: ReturnType<typeof setTimeout>): void => {
    this.queue.delete(id as unknown as number);
  };
  setInterval = (fn: () => void, ms: number): ReturnType<typeof setInterval> => {
    this.id += 1;
    this.queue.set(this.id, { at: this.now + ms, fn, every: ms });
    return this.id as unknown as ReturnType<typeof setInterval>;
  };
  clearInterval = (id: ReturnType<typeof setInterval>): void => {
    this.queue.delete(id as unknown as number);
  };

  /** Pending timeouts (ms until fire). */
  pending(): number[] {
    return [...this.queue.values()].filter((t) => t.every === null).map((t) => t.at - this.now);
  }

  /** Advance the clock, firing due timers in order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.queue.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.now = timer.at;
      if (timer.every === null) this.queue.delete(id);
      else timer.at += timer.every;
      timer.fn();
    }
    this.now = target;
  }
}

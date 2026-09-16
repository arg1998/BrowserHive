/** @module test/helpers/fake-socket — scripted `WsSocket` double: send results (-1 backpressure, 0 dropped), `bufferedAmount`, recorded frames and close codes (spec 09 §4). */

import { WsServerMessage } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type { SendStatus, WsSocket } from '../../src/interface/ws/socket.ts';

/** Records every frame; send results and buffered bytes are scriptable. */
export class FakeSocket implements WsSocket {
  readonly texts: string[] = [];
  readonly binaries: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  /** Bytes reported by `bufferedAmount()`. */
  buffered = 0;
  /** Results returned by the next sends (FIFO); empty → bytes written. */
  readonly sendResults: SendStatus[] = [];

  send(data: string | Uint8Array<ArrayBuffer>): SendStatus {
    const scripted = this.sendResults.shift();
    if (scripted === 0) return 0;
    if (typeof data === 'string') this.texts.push(data);
    else this.binaries.push(data);
    return scripted ?? (typeof data === 'string' ? data.length : data.byteLength);
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  /** Every text frame parsed with the contracts server-message schema (throws on drift). */
  messages(): z.output<typeof WsServerMessage>[] {
    return this.texts.map((t) => WsServerMessage.parse(JSON.parse(t)));
  }

  /** The last parsed message. */
  last(): z.output<typeof WsServerMessage> | undefined {
    return this.messages().at(-1);
  }

  /** Drops recorded frames. */
  clear(): void {
    this.texts.length = 0;
    this.binaries.length = 0;
  }
}

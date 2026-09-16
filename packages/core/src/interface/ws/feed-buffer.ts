/** @module interface/ws/feed-buffer — the bounded, ordered replay buffer of the feed channel (count + bytes + age; spec 03 §6.4). */

import { WS_LIMITS } from '@browserhive/contracts/ws';

/** One buffered event frame. */
export interface BufferedFrame {
  readonly seq: number;
  readonly ts: number;
  readonly topic: string;
  readonly text: string;
  readonly bytes: number;
}

/** Bounds of the buffer (whichever is hit first evicts the oldest frames). */
export interface FeedBufferLimits {
  readonly count: number;
  readonly bytes: number;
  readonly ageMs: number;
}

/** Spec defaults: 10 000 frames / 8 MiB / 5 minutes. */
export const DEFAULT_FEED_LIMITS: FeedBufferLimits = {
  count: WS_LIMITS.feedBufferCount,
  bytes: WS_LIMITS.feedBufferBytes,
  ageMs: WS_LIMITS.feedBufferMs,
};

/** Result of a replay request. */
export type ReplayResult =
  | { readonly complete: true; readonly frames: readonly BufferedFrame[] }
  | { readonly complete: false };

/** Global feed buffer; `seq` is monotonic across every topic (the client cursor). */
export class FeedBuffer {
  private readonly frames: BufferedFrame[] = [];
  private totalBytes = 0;
  private lastSeq = 0;

  constructor(
    private readonly limits: FeedBufferLimits,
    private readonly now: () => number,
  ) {}

  /** Highest assigned `seq` (0 before the first event). */
  get head(): number {
    return this.lastSeq;
  }

  /** Frames currently held. */
  get size(): number {
    return this.frames.length;
  }

  /** Bytes currently held. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Assigns the next `seq`, builds the frame text with it and stores it. */
  append(topic: string, build: (seq: number, ts: number) => string): BufferedFrame {
    const seq = ++this.lastSeq;
    const ts = this.now();
    const text = build(seq, ts);
    const frame: BufferedFrame = { seq, ts, topic, text, bytes: Buffer.byteLength(text) };
    this.frames.push(frame);
    this.totalBytes += frame.bytes;
    this.evict();
    return frame;
  }

  /**
   * Frames with `seq > cursor` on topics accepted by `match`, in order. `complete:false` when
   * events after `cursor` were already evicted (or the cursor is from the future: another epoch).
   */
  replay(cursor: number, match: (topic: string) => boolean): ReplayResult {
    this.evict();
    if (cursor > this.lastSeq) return { complete: false };
    const oldest = this.frames[0]?.seq ?? this.lastSeq + 1;
    if (cursor < this.lastSeq && cursor + 1 < oldest) return { complete: false };
    return {
      complete: true,
      frames: this.frames.filter((f) => f.seq > cursor && match(f.topic)),
    };
  }

  private evict(): void {
    const cutoff = this.now() - this.limits.ageMs;
    while (this.frames.length > 0) {
      const first = this.frames[0];
      if (first === undefined) break;
      const over =
        this.frames.length > this.limits.count ||
        this.totalBytes > this.limits.bytes ||
        first.ts < cutoff;
      if (!over) break;
      this.frames.shift();
      this.totalBytes -= first.bytes;
    }
  }
}

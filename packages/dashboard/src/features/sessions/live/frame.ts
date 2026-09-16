/** @module features/sessions/live/frame — binary screencast frame decode (16-byte header + JPEG) and per-viewer stats: fps over a 1 s window, dropped frames from `seq` gaps, frame age (spec 03 §6.5, spec 04 §13) */
import {
  readScreencastHeader,
  SCREENCAST_HEADER_BYTES,
  type ScreencastFrameHeader,
} from '@browserhive/contracts/ws';

/** Decoded frame. */
export interface DecodedFrame {
  readonly header: ScreencastFrameHeader;
  readonly jpeg: Uint8Array;
}

/** Decode one binary message; `null` when too short, the magic mismatches, or no JPEG follows. */
export function decodeFrame(bytes: Uint8Array): DecodedFrame | null {
  const header = readScreencastHeader(bytes);
  if (header === null || bytes.byteLength <= SCREENCAST_HEADER_BYTES) return null;
  return { header, jpeg: bytes.subarray(SCREENCAST_HEADER_BYTES) };
}

/** Stats snapshot. */
export interface FrameStatsSnapshot {
  readonly fps: number;
  readonly dropped: number;
  readonly received: number;
  /** Milliseconds since the last frame (`null` before the first). */
  readonly ageMs: number | null;
}

/** Mutable per-viewer stats (one instance per hook; never a module singleton). */
export class FrameStats {
  private readonly arrivals: number[] = [];
  private lastSeq: number | null = null;
  private lastAt: number | null = null;
  private droppedCount = 0;
  private receivedCount = 0;

  /** Record a frame arrival. Gaps in `seq` count as dropped (server latest-wins or client skip). */
  record(seq: number, at: number): void {
    if (this.lastSeq !== null && seq > this.lastSeq + 1)
      this.droppedCount += seq - this.lastSeq - 1;
    this.lastSeq = seq;
    this.lastAt = at;
    this.receivedCount += 1;
    this.arrivals.push(at);
    while (this.arrivals.length > 0 && (this.arrivals[0] ?? at) < at - 1000) this.arrivals.shift();
  }

  /** Count a frame decoded but skipped locally because a newer one arrived. */
  skip(): void {
    this.droppedCount += 1;
  }

  /** Forget everything (stream restarted). */
  reset(): void {
    this.arrivals.length = 0;
    this.lastSeq = null;
    this.lastAt = null;
    this.droppedCount = 0;
    this.receivedCount = 0;
  }

  /** Snapshot at `now`. */
  snapshot(now: number): FrameStatsSnapshot {
    const recent = this.arrivals.filter((t) => t >= now - 1000).length;
    return {
      fps: recent,
      dropped: this.droppedCount,
      received: this.receivedCount,
      ageMs: this.lastAt === null ? null : Math.max(0, now - this.lastAt),
    };
  }
}

/** @module interface/ws/live-view-support — per-key serial queue, timeouts and frame decoding for live view. */

import type { CdpFrameMetadata } from './cdp-bridge.ts';

/** A timer seam (`setTimeout` in production, manual in tests); returns a cancel. */
export type Schedule = (fn: () => void, ms: number) => () => void;

/** A decoded frame handed to viewers. */
export interface LiveFrame {
  readonly jpeg: Uint8Array<ArrayBuffer>;
  /** Device (CSS) width of the page the frame shows, clamped to u16. */
  readonly width: number;
  /** Device (CSS) height of the page the frame shows, clamped to u16. */
  readonly height: number;
}

/** Page metadata sent to a viewer whenever it differs from what that viewer last received. */
export interface LiveMeta {
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly pageScale: number;
  readonly offsetTop: number;
}

/**
 * Runs async tasks one at a time per key, in call order. A failed task does not block the tasks
 * queued behind it. Tasks must not enqueue-and-await on their own key (that would deadlock).
 */
export class KeyedSerial {
  private readonly tails = new Map<string, Promise<void>>();

  /** Queues `task` behind every earlier task on `key`; settles with the task's outcome. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Resolves once every task queued so far (on any key) has settled. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }
}

/** Rejects with `Error('<what> timed out after <ms> ms')` when `promise` does not settle in time. */
export function withTimeout<T>(
  schedule: Schedule,
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = schedule(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        reject(error);
      },
    );
  });
}

/** Viewer-facing metadata from CDP frame metadata. */
export function metaOf(metadata: CdpFrameMetadata): LiveMeta {
  return {
    deviceWidth: Math.round(metadata.deviceWidth),
    deviceHeight: Math.round(metadata.deviceHeight),
    pageScale: metadata.pageScaleFactor,
    offsetTop: metadata.offsetTop,
  };
}

/** A viewer frame from base64 JPEG and its metadata. */
export function frameOf(base64: string, meta: LiveMeta): LiveFrame {
  return {
    jpeg: decodeBase64(base64),
    width: Math.max(0, Math.min(0xffff, meta.deviceWidth)),
    height: Math.max(0, Math.min(0xffff, meta.deviceHeight)),
  };
}

/** The message of any thrown value. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(base64, 'base64');
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

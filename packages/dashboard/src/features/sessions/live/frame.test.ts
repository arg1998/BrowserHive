/** @module features/sessions/live/frame.test — binary frame decode (16-byte header + JPEG), stats, stream size presets, fitted frame drawing */
import { describe, expect, it } from 'bun:test';
import { writeScreencastHeader } from '@browserhive/contracts/ws';
import { decodeFrame, FrameStats } from './frame.ts';
import { letterboxRect, toPageCoords } from './input-mapping.ts';
import { streamDims } from './stream-size.ts';
import { drawFrame } from './use-screencast.ts';

function frameBytes(seq: number, jpeg: readonly number[]): Uint8Array {
  const header = writeScreencastHeader({
    magic: 'BHSC',
    ordinal: 7,
    seq,
    width: 1280,
    height: 720,
  });
  const out = new Uint8Array(header.byteLength + jpeg.length);
  out.set(header);
  out.set(jpeg, header.byteLength);
  return out;
}

describe('screencast frames', () => {
  it('decodes the header and slices the JPEG', () => {
    const decoded = decodeFrame(frameBytes(3, [0xff, 0xd8, 0xff, 0xd9]));
    expect(decoded?.header).toEqual({
      magic: 'BHSC',
      ordinal: 7,
      seq: 3,
      width: 1280,
      height: 720,
    });
    expect([...(decoded?.jpeg ?? [])]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it('rejects short frames, bad magic and header-only frames', () => {
    expect(decodeFrame(new Uint8Array(8))).toBeNull();
    const bad = frameBytes(1, [1]);
    bad[0] = 0x58;
    expect(decodeFrame(bad)).toBeNull();
    expect(decodeFrame(frameBytes(1, []))).toBeNull();
  });

  it('counts fps over a second and dropped frames from seq gaps', () => {
    const stats = new FrameStats();
    stats.record(1, 0);
    stats.record(2, 100);
    stats.record(5, 200);
    stats.skip();
    expect(stats.snapshot(250)).toEqual({ fps: 3, dropped: 3, received: 3, ageMs: 50 });
    expect(stats.snapshot(1150).fps).toBe(1);
    stats.reset();
    expect(stats.snapshot(0)).toEqual({ fps: 0, dropped: 0, received: 0, ageMs: null });
  });

  it('derives requested sizes (fit caps DPR at 2×)', () => {
    expect(streamDims('fit', { width: 800, height: 450 }, 3)).toEqual({
      max_width: 1600,
      max_height: 900,
    });
    expect(streamDims('720p', { width: 1, height: 1 }, 1)).toEqual({
      max_width: 1280,
      max_height: 720,
    });
    expect(streamDims('fit', { width: 10, height: 10 }, 1)).toEqual({
      max_width: 64,
      max_height: 64,
    });
  });

  it('draws the frame fitted and centred at device pixels, never at 0,0 natural size', () => {
    const calls: unknown[][] = [];
    const canvas = {
      width: 300,
      height: 150,
      clientWidth: 800,
      clientHeight: 600,
      getContext: () => ({
        clearRect: (...args: unknown[]) => calls.push(['clear', ...args]),
        drawImage: (...args: unknown[]) => calls.push(['draw', ...args]),
      }),
    };
    // A 1280×640 JPEG (downscaled from a 2560×1280 page) in an 800×600 pane at DPR 2.
    const image = { width: 1280, height: 640 };
    const rect = drawFrame(canvas, image, 2);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(rect).toEqual({ x: 0, y: 200, width: 1600, height: 800 });
    expect(calls).toEqual([
      ['clear', 0, 0, 1600, 1200],
      ['draw', image, 0, 200, 1600, 800],
    ]);
    // A tall frame is pillarboxed and centred horizontally.
    expect(drawFrame({ ...canvas, width: 0, height: 0 }, { width: 390, height: 844 }, 1)).toEqual(
      letterboxRect({ width: 800, height: 600 }, { width: 390, height: 844 }),
    );
    expect(drawFrame({ ...canvas, clientWidth: 0 }, image, 1)).toBeNull();
  });

  it('maps input through the same fitted rect the frame is drawn in', () => {
    const box = { width: 800, height: 600 };
    const page = { width: 2560, height: 1280 };
    const drawn = letterboxRect(box, { width: 1280, height: 640 });
    // The centre of the drawn picture is the centre of the page; the bars map to nothing.
    const centre = { x: drawn.x + drawn.width / 2, y: drawn.y + drawn.height / 2 };
    expect(toPageCoords(centre, box, page, null)).toEqual({ x: 1280, y: 640 });
    expect(toPageCoords({ x: drawn.x, y: drawn.y }, box, page, null)).toEqual({ x: 0, y: 0 });
    expect(toPageCoords({ x: 400, y: drawn.y - 1 }, box, page, null)).toBeNull();
  });
});

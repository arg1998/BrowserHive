/// <reference types="bun-types" />
/** @module contracts/test/ws/screencast.test — binary header encode/decode and magic guard */
import { describe, expect, it } from 'bun:test';
import {
  readScreencastHeader,
  SCREENCAST_HEADER_BYTES,
  ScreencastFrameHeader,
  writeScreencastHeader,
} from '../../src/ws/screencast.ts';

describe('screencast header', () => {
  const header = ScreencastFrameHeader.parse({
    magic: 'BHSC',
    ordinal: 7,
    seq: 123_456,
    width: 1280,
    height: 720,
  });
  it('round-trips through 16 bytes', () => {
    const bytes = writeScreencastHeader(header);
    expect(bytes.byteLength).toBe(SCREENCAST_HEADER_BYTES);
    expect(readScreencastHeader(bytes)).toEqual(header);
  });
  it('decodes from an offset view and ignores trailing JPEG bytes', () => {
    const frame = new Uint8Array(SCREENCAST_HEADER_BYTES + 4 + 3);
    frame.set(writeScreencastHeader(header), 4);
    expect(readScreencastHeader(frame.subarray(4))).toEqual(header);
  });
  it('returns null for short buffers and wrong magic', () => {
    expect(readScreencastHeader(new Uint8Array(15))).toBeNull();
    const bytes = writeScreencastHeader(header);
    bytes[0] = 0x41;
    expect(readScreencastHeader(bytes)).toBeNull();
  });
});

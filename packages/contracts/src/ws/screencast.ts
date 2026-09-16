/** @module contracts/ws/screencast — binary frame header layout and JSON stream-control payloads (spec 03 §6.5) */
import { z } from 'zod';
import { SessionId } from '../ids/index.ts';

/** ASCII magic at the start of every binary frame. */
export const SCREENCAST_MAGIC = 'BHSC';
/** Total header length in bytes; JPEG bytes follow immediately. */
export const SCREENCAST_HEADER_BYTES = 16;
/**
 * Byte offsets of the big-endian header fields:
 * `[0..3]` magic, `[4..7]` ordinal u32, `[8..11]` seq u32, `[12..13]` width u16, `[14..15]` height u16.
 */
export const SCREENCAST_HEADER_LAYOUT = {
  magic: 0,
  ordinal: 4,
  seq: 8,
  width: 12,
  height: 14,
} as const;

const u32 = z.number().int().min(0).max(0xffff_ffff);
const u16 = z.number().int().min(0).max(0xffff);

/**
 * Decoded binary frame header. `ordinal` identifies the screencast on this connection (assigned in the
 * `screencast.start` reply); `seq` is per-screencast and monotonic (latest-wins: a lower `seq` after a
 * higher one is dropped); `width`/`height` are the page viewport in CSS pixels (the JPEG may be downscaled).
 */
export const ScreencastFrameHeader = z.object({
  magic: z.literal(SCREENCAST_MAGIC),
  ordinal: u32,
  seq: u32,
  width: u16,
  height: u16,
});
/** Decoded binary frame header. */
export type ScreencastFrameHeader = z.infer<typeof ScreencastFrameHeader>;

/** Decode a frame header from the first 16 bytes; `null` when too short or the magic mismatches. */
export function readScreencastHeader(bytes: Uint8Array): ScreencastFrameHeader | null {
  if (bytes.byteLength < SCREENCAST_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (magic !== SCREENCAST_MAGIC) return null;
  return {
    magic: SCREENCAST_MAGIC,
    ordinal: view.getUint32(SCREENCAST_HEADER_LAYOUT.ordinal),
    seq: view.getUint32(SCREENCAST_HEADER_LAYOUT.seq),
    width: view.getUint16(SCREENCAST_HEADER_LAYOUT.width),
    height: view.getUint16(SCREENCAST_HEADER_LAYOUT.height),
  };
}

/** Encode a frame header into a fresh 16-byte buffer (the server prepends it to the JPEG). */
export function writeScreencastHeader(header: ScreencastFrameHeader): Uint8Array {
  const out = new Uint8Array(SCREENCAST_HEADER_BYTES);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) out[i] = SCREENCAST_MAGIC.charCodeAt(i);
  view.setUint32(SCREENCAST_HEADER_LAYOUT.ordinal, header.ordinal);
  view.setUint32(SCREENCAST_HEADER_LAYOUT.seq, header.seq);
  view.setUint16(SCREENCAST_HEADER_LAYOUT.width, header.width);
  view.setUint16(SCREENCAST_HEADER_LAYOUT.height, header.height);
  return out;
}

/** Screencast metadata; sent once per size change. */
export const ScreencastMetaPayload = z.object({
  type: z.literal('meta'),
  session_id: SessionId,
  ordinal: u32,
  device_width: u16,
  device_height: u16,
  page_scale: z.number().positive(),
  offset_top: z.number(),
});
/** Screencast is running for this viewer. */
export const ScreencastStartedPayload = z.object({
  type: z.literal('started'),
  session_id: SessionId,
  ordinal: u32,
});
/** Screencast stopped (last viewer left, session closed/crashed, or operator stop). */
export const ScreencastStoppedPayload = z.object({
  type: z.literal('stopped'),
  session_id: SessionId,
  reason: z.enum(['stopped', 'session_closed', 'session_crashed', 'connection_closed']),
});
/** Screencast could not be started or died. */
export const ScreencastFailedPayload = z.object({
  type: z.literal('failed'),
  session_id: SessionId,
  code: z.string(),
  message: z.string().optional(),
});

/** JSON control messages on `screencast:<id>` topics (`kind: 'stream'`), discriminated on `type`. */
export const ScreencastControl = z.discriminatedUnion('type', [
  ScreencastMetaPayload,
  ScreencastStartedPayload,
  ScreencastStoppedPayload,
  ScreencastFailedPayload,
]);
/** JSON control messages on `screencast:<id>` topics. */
export type ScreencastControl = z.infer<typeof ScreencastControl>;

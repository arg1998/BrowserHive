/** @module interface/http/byte-range — single `Range: bytes=` parsing incl. suffix ranges (RFC 9110 §14). */

/** An inclusive byte range. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parses one byte range against `size`. `null` = no/ignorable header (serve the whole file),
 * `'unsatisfiable'` = 416. Multiple ranges are not supported and are served whole.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, startText = '', endText = ''] = match;
  if (startText === '' && endText === '') return null;
  if (startText === '') {
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  const end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

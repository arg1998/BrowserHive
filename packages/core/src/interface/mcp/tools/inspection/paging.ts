/** @module interface/mcp/tools/inspection/paging — the one paging convention of the reading tools (`get_content`, `get_text`, `snapshot`): `max_chars`/`offset` in, `total_chars`/`truncated`/`next_offset` out (spec 02 §3.6). */

/** One page of a text, with the paging fields every reading tool returns. */
export interface TextPage {
  /** The characters of this page. */
  readonly chunk: string;
  /** Length of the whole text, in UTF-16 code units. */
  readonly total_chars: number;
  /** True when the text continues after this page. */
  readonly truncated: boolean;
  /** Where the next page starts, or `null` when this page reached the end. */
  readonly next_offset: number | null;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when index `at` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, at: number): boolean {
  return (
    at > 0 &&
    at < text.length &&
    isHighSurrogate(text.charCodeAt(at - 1)) &&
    isLowSurrogate(text.charCodeAt(at))
  );
}

/**
 * Cuts `[offset, offset + maxChars)` out of `text` without splitting a surrogate pair. An `offset`
 * inside a pair moves back to the pair's start; an end inside a pair moves back one, unless that
 * would leave the page empty (then the page holds the whole pair, one character over `maxChars`).
 * An `offset` at or past the end answers an empty, final page. Concatenating the pages from offset
 * 0 along `next_offset` gives back `text` exactly.
 */
export function pageText(text: string, offset: number, maxChars: number): TextPage {
  const total = text.length;
  let start = Math.min(Math.max(0, offset), total);
  if (splitsPair(text, start)) start -= 1;
  let end = Math.min(start + Math.max(1, maxChars), total);
  if (splitsPair(text, end)) end = end - 1 > start ? end - 1 : end + 1;
  const truncated = end < total;
  return {
    chunk: text.slice(start, end),
    total_chars: total,
    truncated,
    next_offset: truncated ? end : null,
  };
}

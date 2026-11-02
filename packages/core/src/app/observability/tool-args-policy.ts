/** @module app/observability/tool-args-policy — D-47 recording of tool-call arguments: at most 64 KiB of serialized JSON, a still-valid marker object above it. */

import { TOOL_ARGS_CAP_BYTES, type TruncatedToolArgs } from '@browserhive/contracts/http';
import type { JsonObject } from '../../ports/persistence/records.ts';

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** The first `end` UTF-16 units of `text`, one fewer when the last would be half a surrogate pair. */
function prefixOf(text: string, end: number): string {
  const last = text.charCodeAt(end - 1);
  const cut = end > 0 && last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
  return text.slice(0, cut);
}

function marker(bytes: number, preview: string): TruncatedToolArgs {
  return { _truncated: true, bytes, preview };
}

/**
 * Caps arguments for storage (D-47). `args` must already be redacted: redaction runs before the cap,
 * never after (10 §9), so a cut can neither hide a sensitive key nor split a registered literal.
 * Arguments whose serialization fits in `maxBytes` of UTF-8 come back unchanged; larger ones become
 * `{ _truncated: true, bytes, preview }`, where `bytes` is the full serialized size and `preview` the
 * longest prefix of the serialization for which the whole marker still serializes within `maxBytes`.
 */
export function capToolArgs(args: JsonObject, maxBytes: number = TOOL_ARGS_CAP_BYTES): JsonObject {
  const serialized = JSON.stringify(args);
  const bytes = utf8Bytes(serialized);
  if (bytes <= maxBytes) return args;
  // Escaping in the preview (quotes, backslashes) only adds bytes, so the marker's size grows with
  // the prefix length and the longest prefix that fits is found by binary search. A prefix longer
  // than `maxBytes` UTF-16 units is at least `maxBytes` bytes, so that bounds the search.
  let low = 0;
  let high = Math.min(serialized.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const size = utf8Bytes(JSON.stringify(marker(bytes, prefixOf(serialized, mid))));
    if (size <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return marker(bytes, prefixOf(serialized, low));
}
